import { proveChain } from "./planner.js";
import { hourOf } from "./time.js";

/**
 * 联票服务：出票（须先通过链路可达性证明）与验票核销。
 * 权益按 联票×场次×成员 核销，天然支持家庭联票；同一键只消耗一次，
 * 多点扫码与离线闸机补传只会被判为重复，不会二次消耗。
 */
export class PassService {
  constructor(store, registry) {
    this.store = store;
    this.registry = registry;
    this.passes = new Map();
    this.entriesBySession = new Map();
  }

  /** 售票：证明通过才出票，并锁定沿途场次与返程班次容量。 */
  issuePass({ pass_id, kind = "single", members, request, occurred_at }) {
    if (this.passes.has(pass_id)) throw new Error(`联票已存在：${pass_id}`);
    const proof = proveChain(this.registry, { ...request, party: members });
    if (!proof.feasible) return { ok: false, violations: proof.violations };

    const size = members.length;
    for (const leg of proof.timeline) {
      if (leg.kind === "activity") this.registry.sessions.get(leg.activity_id).remaining -= size;
      if (leg.kind === "transit") this.registry.transit.get(leg.connection_id).remaining -= size;
    }
    const chosenReturn = proof.returnOptions[0];
    if (chosenReturn) this.registry.transit.get(chosenReturn.connection_id).remaining -= size;

    const pass = {
      pass_id,
      kind,
      members,
      entitlements: proof.timeline
        .filter((l) => l.kind === "activity")
        .map((l) => ({ activity_id: l.activity_id, per_member: true })),
      plan: {
        timeline: proof.timeline,
        home: request.home ?? null,
        returnOptions: proof.returnOptions,
        chosen_return: chosenReturn ? chosenReturn.connection_id : null,
      },
      consumed: new Map(),
      status: "active",
    };
    this.passes.set(pass_id, pass);

    this.store.record({
      event_type: "CONNECTION_VALIDATED",
      aggregate_type: "night_pass",
      aggregate_id: pass_id,
      occurred_at,
      summary: "售票前链路可达性证明通过",
      proof: { legs: proof.timeline, return_options: proof.returnOptions },
    });
    this.store.record({
      event_type: "PASS_ISSUED",
      aggregate_type: "night_pass",
      aggregate_id: pass_id,
      occurred_at,
      summary: `售出${kind === "family" ? "家庭" : "单人"}夜游联票`,
      members: members.map((m) => m.member_id),
    });
    return { ok: true, pass };
  }

  hasAnyEntry(pass, activityId) {
    for (const key of pass.consumed.keys()) {
      if (key.split("|")[1] === activityId) return true;
    }
    return false;
  }

  /** 单次核销（闸机扫码）。 */
  recordEntry({ pass_id, activity_id, member_id, gate_id, scanned_at, offline = false }) {
    const pass = this.passes.get(pass_id);
    if (!pass) return { ok: false, reason: "联票不存在" };
    if (pass.status !== "active") return { ok: false, reason: "联票状态不可用" };
    if (!pass.entitlements.some((e) => e.activity_id === activity_id)) {
      return { ok: false, reason: "该场次不在联票权益内" };
    }
    const member = pass.members.find((m) => m.member_id === member_id);
    if (!member) return { ok: false, reason: "成员不属于此联票" };

    const key = `${pass_id}|${activity_id}|${member_id}`;
    if (pass.consumed.has(key)) return { ok: false, duplicate: true, reason: "权益已核销，拒绝重复消耗" };

    const session = this.registry.sessions.get(activity_id);
    const venue = this.registry.venues.get(session.venue_id);
    const isNight = session.night || hourOf(session.start) >= venue.night_from_hour;
    if (isNight && member.age < venue.night_guardian_max_age) {
      const guardian = pass.members.find((p) => p.age >= 18 && (p.guardian_of ?? []).includes(member_id));
      const guardianKey = guardian ? `${pass_id}|${activity_id}|${guardian.member_id}` : null;
      if (!guardian || !pass.consumed.has(guardianKey)) {
        return { ok: false, reason: "未成年人夜间项目须监护人同场核验" };
      }
    }

    const count = this.entriesBySession.get(activity_id) ?? 0;
    if (count >= session.capacity) return { ok: false, reason: "场馆已满" };

    pass.consumed.set(key, { gate_id, scanned_at, offline });
    this.entriesBySession.set(activity_id, count + 1);
    this.store.record({
      event_type: "ENTRY_RECORDED",
      aggregate_type: "night_pass",
      aggregate_id: pass_id,
      occurred_at: scanned_at,
      summary: `${member_id} 核销 ${activity_id}`,
      entry: { activity_id, member_id, gate_id, offline },
    });
    return { ok: true };
  }

  /**
   * 批量核销：同一批（家庭同时扫码、离线闸机补传）先处理成年监护人，
   * 使未成年人监护核验在同一批内也能成立。
   */
  recordEntries(batch) {
    const results = { accepted: [], duplicates: [], rejected: [] };
    const rank = (e) => {
      const pass = this.passes.get(e.pass_id);
      const m = pass?.members.find((x) => x.member_id === e.member_id);
      return m && m.age >= 18 ? 0 : 1;
    };
    for (const entry of [...batch].sort((a, b) => rank(a) - rank(b))) {
      const r = this.recordEntry(entry);
      if (r.ok) results.accepted.push(entry);
      else if (r.duplicate) results.duplicates.push({ entry, reason: r.reason });
      else results.rejected.push({ entry, reason: r.reason });
    }
    return results;
  }

  /** 离线闸机补传：重复记录只上报，不重复消耗权益。 */
  uploadOfflineBatch(gate_id, entries) {
    return this.recordEntries(entries.map((e) => ({ ...e, gate_id, offline: true })));
  }
}

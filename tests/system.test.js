import assert from "node:assert/strict";
import test from "node:test";

import { createSystem } from "../src/index.js";

const AT = "2026-10-04T12:00:00+08:00";
const VENUE_RIV = { role: "venue", operator_id: "venue-riv" };
const VENUE_MUS = { role: "venue", operator_id: "venue-mus" };
const METRO = { role: "transit", operator_id: "metro-co" };

function makeSystem() {
  const sys = createSystem();
  const R = sys.registry;
  R.addVenue({ venue_id: "MUS", name: "城市博物馆", owner: "venue-mus" });
  R.addVenue({ venue_id: "RIV", name: "河上演艺", owner: "venue-riv", outdoor: true });
  R.addSession({ activity_id: "MUS-1900", venue_id: "MUS", start: "2026-10-04T19:00:00+08:00", end: "2026-10-04T20:30:00+08:00", capacity: 100 });
  R.addSession({ activity_id: "RIV-2100", venue_id: "RIV", start: "2026-10-04T21:00:00+08:00", end: "2026-10-04T22:10:00+08:00", capacity: 50, night: true });
  R.addSession({ activity_id: "RIV-2130", venue_id: "RIV", start: "2026-10-04T21:30:00+08:00", end: "2026-10-04T22:40:00+08:00", capacity: 50, night: true });
  R.addWalk({ from: "MUS", to: "RIV", minutes: 20 });
  R.addWalk({ from: "RIV", to: "METRO", minutes: 10 });
  R.addTransit({ connection_id: "MET-2230", operator: "metro-co", from: "METRO", to: "HOME", depart: "2026-10-04T22:30:00+08:00", arrive: "2026-10-04T23:00:00+08:00", capacity: 100 });
  R.addTransit({ connection_id: "MET-2300", operator: "metro-co", from: "METRO", to: "HOME", depart: "2026-10-04T23:00:00+08:00", arrive: "2026-10-04T23:30:00+08:00", capacity: 2 });
  return sys;
}

const LEGS = [
  { activity: "MUS-1900" },
  { walk: { from: "MUS", to: "RIV" } },
  { activity: "RIV-2100" },
  { walk: { from: "RIV", to: "METRO" } },
];

const ADULT = { member_id: "P1", age: 38, guardian_of: ["C1"] };
const CHILD = { member_id: "C1", age: 9 };

function issue(sys, passId, members) {
  return sys.passes.issuePass({
    pass_id: passId,
    kind: members.length > 1 ? "family" : "single",
    members,
    request: { legs: LEGS, home: "HOME" },
    occurred_at: AT,
  });
}

test("售票前证明整条链路可达，出票并锁定容量", () => {
  const sys = makeSystem();
  const r = issue(sys, "PASS-1", [ADULT]);
  assert.equal(r.ok, true);
  const events = sys.store.eventsOf("PASS-1");
  assert.deepEqual(events.map((e) => e.event_type), ["CONNECTION_VALIDATED", "PASS_ISSUED"]);
  assert.equal(events[0].proof.return_options.length, 2);
  const pass = sys.passes.passes.get("PASS-1");
  assert.equal(pass.plan.chosen_return, "MET-2230");
  assert.equal(pass.plan.returnOptions.at(-1).is_last_service, true);
  assert.equal(sys.registry.sessions.get("RIV-2100").remaining, 49);
  assert.equal(sys.registry.transit.get("MET-2230").remaining, 99);
});

test("散场晚十分钟错过末班：无返程班次时拒绝出票", () => {
  const sys = makeSystem();
  sys.applyTransitUpdate(METRO, { connection_id: "MET-2230", cancel: true }, AT);
  sys.applyTransitUpdate(METRO, { connection_id: "MET-2300", cancel: true }, AT);
  const r = issue(sys, "PASS-1", [ADULT]);
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.includes("无可用返程班次")));
});

test("缺少步行换乘数据时拒绝出票", () => {
  const sys = makeSystem();
  const r = sys.passes.issuePass({
    pass_id: "PASS-1",
    members: [ADULT],
    request: { legs: [{ activity: "MUS-1900" }, { walk: { from: "MUS", to: "NOWHERE" } }], home: "HOME" },
    occurred_at: AT,
  });
  assert.equal(r.ok, false);
  assert.ok(r.violations.some((v) => v.includes("缺少 MUS 到 NOWHERE 的步行换乘数据")));
});

test("场馆容量与年龄、监护规则在售票时校验", () => {
  const sys = makeSystem();
  const crowd = Array.from({ length: 51 }, (_, i) => ({ member_id: `M${i}`, age: 30 }));
  const full = issue(sys, "PASS-BIG", crowd);
  assert.equal(full.ok, false);
  assert.ok(full.violations.some((v) => v.includes("容量不足")));

  const alone = issue(sys, "PASS-KID", [CHILD]);
  assert.equal(alone.ok, false);
  assert.ok(alone.violations.some((v) => v.includes("监护人同行")));
});

test("家庭联票按成员核销，多点扫码与离线补传不重复消耗", () => {
  const sys = makeSystem();
  issue(sys, "PASS-F", [ADULT, CHILD]);
  const scan = { pass_id: "PASS-F", activity_id: "MUS-1900", member_id: "P1", gate_id: "G1", scanned_at: "2026-10-04T19:05:00+08:00" };
  assert.equal(sys.passes.recordEntry(scan).ok, true);
  const batch = sys.passes.uploadOfflineBatch("G-OFFLINE", [
    { ...scan, scanned_at: "2026-10-04T19:06:00+08:00" },
    { pass_id: "PASS-F", activity_id: "MUS-1900", member_id: "C1", scanned_at: "2026-10-04T19:07:00+08:00" },
  ]);
  assert.equal(batch.duplicates.length, 1);
  assert.equal(batch.accepted.length, 1);
  assert.equal(sys.passes.entriesBySession.get("MUS-1900"), 2);
  assert.equal(sys.store.eventsOf("PASS-F").filter((e) => e.event_type === "ENTRY_RECORDED").length, 2);
});

test("未成年人夜间项目须监护人同场核验", () => {
  const sys = makeSystem();
  issue(sys, "PASS-F", [ADULT, CHILD]);
  const at = "2026-10-04T21:05:00+08:00";
  const childFirst = sys.passes.recordEntry({ pass_id: "PASS-F", activity_id: "RIV-2100", member_id: "C1", gate_id: "G2", scanned_at: at });
  assert.equal(childFirst.ok, false);
  assert.ok(childFirst.reason.includes("监护人同场核验"));
  assert.equal(sys.passes.recordEntry({ pass_id: "PASS-F", activity_id: "RIV-2100", member_id: "P1", gate_id: "G2", scanned_at: at }).ok, true);
  assert.equal(sys.passes.recordEntry({ pass_id: "PASS-F", activity_id: "RIV-2100", member_id: "C1", gate_id: "G2", scanned_at: at }).ok, true);
});

test("场馆延误沿后继计划传播，已入场游客优先获得返程方案", () => {
  const sys = makeSystem();
  issue(sys, "PASS-A", [ADULT, CHILD]);
  issue(sys, "PASS-B", [{ member_id: "P2", age: 30 }]);
  sys.passes.recordEntry({ pass_id: "PASS-A", activity_id: "MUS-1900", member_id: "P1", gate_id: "G1", scanned_at: "2026-10-04T19:05:00+08:00" });

  const affected = sys.applySessionUpdate(VENUE_RIV, { activity_id: "RIV-2100", delay_min: 45 }, "2026-10-04T21:30:00+08:00");
  assert.equal(affected.length, 2);
  assert.equal(affected[0].pass_id, "PASS-A");
  assert.equal(affected[0].priority, "entered");
  assert.equal(affected[1].priority, "standard");

  const view = sys.visitorTimeline("PASS-A");
  assert.equal(view.legs.find((l) => l.kind === "activity" && l.activity_id === "MUS-1900").status, "done");
  assert.equal(view.last_return_options.length, 0);
  assert.ok(view.recovery);

  const board = sys.dutyBoard();
  assert.equal(board.length, 2);
  const rowA = board.find((r) => r.pass_id === "PASS-A");
  assert.equal(rowA.entered, true);
  assert.deepEqual(rowA.members.map((m) => m.minor), [true, false].sort());
  assert.equal(rowA.notification.status, "sent");
  sys.confirmNotification(rowA.notification.notification_id, true, "2026-10-04T21:35:00+08:00");
  assert.equal(sys.dutyBoard().find((r) => r.pass_id === "PASS-A").notification.status, "delivered");
});

test("临时加班班次使断裂的计划恢复可达", () => {
  const sys = makeSystem();
  issue(sys, "PASS-1", [ADULT]);
  sys.applySessionUpdate(VENUE_RIV, { activity_id: "RIV-2100", delay_min: 45 }, "2026-10-04T21:30:00+08:00");
  assert.equal(sys.engine.openPlanOf("PASS-1").status, "open");

  sys.addExtraTransit(METRO, { connection_id: "MET-2315", operator: "metro-co", from: "METRO", to: "HOME", depart: "2026-10-04T23:15:00+08:00", arrive: "2026-10-04T23:45:00+08:00", capacity: 50 }, "2026-10-04T21:40:00+08:00");
  assert.equal(sys.engine.openPlanOf("PASS-1"), undefined);
  const plan = [...sys.engine.plans.values()][0];
  assert.equal(plan.status, "resolved");
  assert.equal(sys.visitorTimeline("PASS-1").last_return_options[0].connection_id, "MET-2315");
});

test("班次取消按交通方责任开放应急包车并确认", () => {
  const sys = makeSystem();
  issue(sys, "PASS-1", [ADULT]);
  sys.applyTransitUpdate(METRO, { connection_id: "MET-2230", cancel: true }, "2026-10-04T22:00:00+08:00");
  sys.applyTransitUpdate(METRO, { connection_id: "MET-2300", cancel: true }, "2026-10-04T22:01:00+08:00");

  const plan = sys.engine.openPlanOf("PASS-1");
  assert.ok(plan.options.some((o) => o.kind === "emergency_bus"));
  const r = sys.recovery.confirm(plan.plan_id, "emergency_bus", { depart: "2026-10-04T23:20:00+08:00", arrive: "2026-10-04T23:50:00+08:00" }, "2026-10-04T22:05:00+08:00");
  assert.equal(r.result.emergency_bus, `EB-${plan.plan_id}`);
  const pass = sys.passes.passes.get("PASS-1");
  assert.equal(pass.plan.chosen_return, `EB-${plan.plan_id}`);
  assert.equal(sys.registry.transit.get(`EB-${plan.plan_id}`).remaining, 0);
  assert.equal(sys.store.eventsOf(plan.plan_id)[0].event_type, "RECOVERY_CONFIRMED");
});

test("改签替代场次：权益与容量随之转移，已入场场次不可改签", () => {
  const sys = makeSystem();
  issue(sys, "PASS-1", [ADULT]);
  sys.applySessionUpdate(VENUE_RIV, { activity_id: "RIV-2100", delay_min: 45 }, "2026-10-04T21:30:00+08:00");
  const plan = sys.engine.openPlanOf("PASS-1");
  assert.ok(plan.options.some((o) => o.kind === "rebook"));
  assert.ok(!plan.options.some((o) => o.kind === "emergency_bus"));

  const r = sys.recovery.confirm(plan.plan_id, "rebook", { activity_id: "RIV-2100", new_activity_id: "RIV-2130" }, "2026-10-04T21:45:00+08:00");
  assert.deepEqual(r.result.rebooked, { from: "RIV-2100", to: "RIV-2130" });
  const pass = sys.passes.passes.get("PASS-1");
  assert.ok(pass.entitlements.some((e) => e.activity_id === "RIV-2130"));
  assert.equal(sys.registry.sessions.get("RIV-2100").remaining, 50);
  assert.equal(sys.registry.sessions.get("RIV-2130").remaining, 49);

  const sys2 = makeSystem();
  issue(sys2, "PASS-2", [ADULT]);
  sys2.passes.recordEntry({ pass_id: "PASS-2", activity_id: "MUS-1900", member_id: "P1", gate_id: "G1", scanned_at: "2026-10-04T19:05:00+08:00" });
  sys2.applySessionUpdate(VENUE_RIV, { activity_id: "RIV-2100", delay_min: 45 }, "2026-10-04T21:30:00+08:00");
  const plan2 = sys2.engine.openPlanOf("PASS-2");
  assert.throws(() => sys2.recovery.confirm(plan2.plan_id, "rebook", { activity_id: "MUS-1900", new_activity_id: "RIV-2130" }, AT), /已入场场次不可改签/);
});

test("退款按责任来源记账", () => {
  const sys = makeSystem();
  issue(sys, "PASS-1", [ADULT]);
  sys.applySessionUpdate(VENUE_RIV, { activity_id: "RIV-2100", delay_min: 45 }, "2026-10-04T21:30:00+08:00");
  const plan = sys.engine.openPlanOf("PASS-1");
  const r = sys.recovery.confirm(plan.plan_id, "refund", { amount: 120 }, "2026-10-04T21:40:00+08:00");
  assert.equal(r.result.refund.account, "venue:venue-riv");

  const sys2 = makeSystem();
  issue(sys2, "PASS-2", [ADULT]);
  sys2.applyTransitUpdate(METRO, { connection_id: "MET-2230", cancel: true }, AT);
  sys2.applyTransitUpdate(METRO, { connection_id: "MET-2300", cancel: true }, AT);
  const plan2 = sys2.engine.openPlanOf("PASS-2");
  assert.equal(plan2.options.find((o) => o.kind === "refund").account, "transit:metro-co");
});

test("场馆和交通方只能维护自己的资源", () => {
  const sys = makeSystem();
  assert.throws(() => sys.applySessionUpdate(VENUE_MUS, { activity_id: "RIV-2100", delay_min: 10 }, AT), /无权维护他人资源/);
  assert.throws(() => sys.applySessionUpdate(METRO, { activity_id: "MUS-1900", delay_min: 10 }, AT), /无权维护他人资源/);
  assert.throws(() => sys.applyTransitUpdate(VENUE_RIV, { connection_id: "MET-2230", cancel: true }, AT), /无权维护他人资源/);
  const affected = sys.applySessionUpdate(VENUE_RIV, { activity_id: "RIV-2100", delay_min: 10 }, AT);
  assert.equal(affected.length, 0);
});

test("外部更新必须携带正确的下一版本号", () => {
  const sys = makeSystem();
  const base = {
    event_id: "ext-1",
    event_type: "DELAY_PROPAGATED",
    aggregate_type: "transit_connection",
    aggregate_id: "MET-2230",
    occurred_at: AT,
    summary: "外部系统延误通报",
  };
  assert.throws(() => sys.store.submit({ ...base, version: 5 }), /版本冲突/);
  const ok = sys.store.submit({ ...base, version: 1 });
  assert.equal(ok.version, 1);
  assert.throws(() => sys.store.submit({ ...base, event_id: "ext-2", version: 1 }), /版本冲突/);
});

test("天气预警下户外场次须有室内预案才可售", () => {
  const sys = makeSystem();
  sys.registry.setWeatherAlert("2026-10-04");
  const rejected = issue(sys, "PASS-1", [ADULT]);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.violations.some((v) => v.includes("室内预案")));

  sys.registry.addVenue({ venue_id: "RIV-HALL", name: "演艺室内厅", owner: "venue-riv" });
  sys.registry.addSession({ activity_id: "RIV-IN-2100", venue_id: "RIV-HALL", start: "2026-10-04T21:00:00+08:00", end: "2026-10-04T22:10:00+08:00", capacity: 50 });
  sys.registry.venues.get("RIV").indoor_fallback = "RIV-IN-2100";
  const accepted = issue(sys, "PASS-2", [ADULT]);
  assert.equal(accepted.ok, true);
  const leg = sys.passes.passes.get("PASS-2").plan.timeline.find((l) => l.activity_id === "RIV-2100");
  assert.equal(leg.weather_fallback, "RIV-IN-2100");
});

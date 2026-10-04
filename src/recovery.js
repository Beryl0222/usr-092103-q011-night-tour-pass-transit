/**
 * 补救服务：退款、改签、应急包车按责任来源与合同规则开放。
 * 责任来源决定可用选项与退款账户；确认后写入 RECOVERY_CONFIRMED。
 */
export const LIABILITY_RULES = {
  venue: {
    rebook: true,
    refundAccount: (cause) => `venue:${cause.operator ?? "unknown"}`,
    emergency_bus: false,
  },
  transit: {
    rebook: true,
    refundAccount: (cause) => `transit:${cause.operator ?? "unknown"}`,
    emergency_bus: true,
  },
  weather: {
    rebook: true,
    refundAccount: () => null, // 天气只启用预案与改签，不退款
    emergency_bus: false,
  },
  platform: {
    rebook: true,
    refundAccount: () => "platform",
    emergency_bus: true,
  },
};

export class RecoveryService {
  constructor(store, registry, passService, engine) {
    this.store = store;
    this.registry = registry;
    this.passService = passService;
    this.engine = engine;
  }

  /**
   * 确认补救选项。
   * details: rebook 需要 { activity_id, new_activity_id }；
   *          refund 需要 { amount }；
   *          emergency_bus 需要 { depart, arrive }，actor 固定为平台（按合同代交通方调车）。
   */
  confirm(plan_id, optionKind, details, occurred_at) {
    const plan = this.engine.plans.get(plan_id);
    if (!plan || plan.status !== "open") throw new Error(`补救计划不可确认：${plan_id}`);
    const option = plan.options.find((o) => o.kind === optionKind && o.status === "offered");
    if (!option) throw new Error(`补救选项不可用（责任来源或合同规则不允许）：${optionKind}`);
    const pass = this.passService.passes.get(plan.pass_id);
    const size = pass.members.length;
    const result = {};

    if (optionKind === "rebook") {
      const { activity_id, new_activity_id } = details;
      if (this.passService.hasAnyEntry(pass, activity_id)) throw new Error("已入场场次不可改签");
      const target = this.registry.sessions.get(new_activity_id);
      if (!target || target.cancelled || target.remaining < size) throw new Error("替代场次不可用");
      const old = this.registry.sessions.get(activity_id);
      old.remaining += size;
      target.remaining -= size;
      pass.entitlements.find((e) => e.activity_id === activity_id).activity_id = new_activity_id;
      const leg = pass.plan.timeline.find((l) => l.kind === "activity" && l.activity_id === activity_id);
      leg.activity_id = new_activity_id;
      leg.venue_id = target.venue_id;
      leg.start = target.start;
      leg.end = target.end;
      result.rebooked = { from: activity_id, to: new_activity_id };
    } else if (optionKind === "refund") {
      result.refund = { account: option.account, amount: details.amount };
    } else if (optionKind === "emergency_bus") {
      const last = pass.plan.timeline[pass.plan.timeline.length - 1];
      const fromNode = last.kind === "transit" ? last.to : last.venue_id;
      const conn = {
        connection_id: `EB-${plan.plan_id}`,
        operator: plan.cause.operator ?? "platform",
        from: fromNode,
        to: pass.plan.home,
        depart: details.depart,
        arrive: details.arrive,
        capacity: size,
      };
      this.registry.addExtraTransit({ role: "platform" }, conn, occurred_at);
      this.registry.transit.get(conn.connection_id).remaining -= size;
      pass.plan.returnOptions = [
        {
          connection_id: conn.connection_id,
          from: conn.from,
          to: conn.to,
          walk_min: 0,
          depart: conn.depart,
          arrive: conn.arrive,
          is_last_service: true,
          emergency: true,
        },
      ];
      pass.plan.chosen_return = conn.connection_id;
      result.emergency_bus = conn.connection_id;
    }

    option.status = "confirmed";
    for (const o of plan.options) if (o.status === "offered") o.status = "closed";
    plan.status = "confirmed";
    plan.result = result;
    this.store.record({
      event_type: "RECOVERY_CONFIRMED",
      aggregate_type: "recovery_plan",
      aggregate_id: plan.plan_id,
      occurred_at,
      summary: `确认补救方案：${optionKind}`,
      option: optionKind,
      result,
      pass_id: plan.pass_id,
    });
    return { ok: true, result };
  }
}

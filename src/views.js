/**
 * 读侧视图：游客时间线与值班看板。
 */

/** 游客视角：一条时间线看清下一站与最后返程选择。 */
export function visitorTimeline(passService, engine, passId) {
  const pass = passService.passes.get(passId);
  if (!pass) return null;
  const openPlan = [...engine.plans.values()].find((p) => p.pass_id === passId && p.status === "open");
  const brokenIds = new Set((openPlan?.broken ?? []).map((b) => b.id));
  const legs = pass.plan.timeline.map((leg) => {
    const id = leg.kind === "activity" ? leg.activity_id : leg.kind === "transit" ? leg.connection_id : null;
    const done = leg.kind === "activity" && passService.hasAnyEntry(pass, leg.activity_id);
    return { ...leg, status: brokenIds.has(id) ? "at_risk" : done ? "done" : "upcoming" };
  });
  const nextStop = legs.find((l) => l.status !== "done") ?? null;
  return {
    pass_id: pass.pass_id,
    legs,
    next_stop: nextStop,
    last_return_options: pass.plan.returnOptions,
    recovery: openPlan
      ? { plan_id: openPlan.plan_id, priority: openPlan.priority, options: openPlan.options }
      : null,
  };
}

/** 值班视角：一次延误影响了哪些人、补救进展、通知是否送达。 */
export function dutyBoard(engine, passService, causeEventId = null) {
  return [...engine.plans.values()]
    .filter((p) => !causeEventId || p.cause.event_id === causeEventId)
    .map((p) => {
      const pass = passService.passes.get(p.pass_id);
      const notification = engine.notifications.find((n) => n.pass_id === p.pass_id);
      return {
        recovery_plan_id: p.plan_id,
        pass_id: p.pass_id,
        members: pass.members.map((m) => ({ member_id: m.member_id, minor: m.age < 18 })),
        entered: p.entered,
        priority: p.priority,
        status: p.status,
        options: p.options.map((o) => ({ kind: o.kind, status: o.status })),
        notification: notification
          ? { notification_id: notification.notification_id, status: notification.status }
          : null,
      };
    });
}

/** 值班人员确认通知送达结果。 */
export function confirmNotification(engine, notificationId, delivered, at) {
  const n = engine.notifications.find((x) => x.notification_id === notificationId);
  if (!n) throw new Error(`通知不存在：${notificationId}`);
  n.status = delivered ? "delivered" : "failed";
  n.confirmed_at = at;
  return n;
}

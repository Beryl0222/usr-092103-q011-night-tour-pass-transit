import { revalidatePlan } from "./planner.js";
import { LIABILITY_RULES } from "./recovery.js";

/**
 * 传播引擎：资源变更（延误/取消/加班）后，沿每张受影响联票的后继计划重算。
 * 已入场的游客标记为最高优先级，优先生成可执行的返程方案；
 * 临时加班资源会让原本断裂的计划恢复可达，未结的补救计划随之关闭。
 */
export class PropagationEngine {
  constructor(store, registry, passService) {
    this.store = store;
    this.registry = registry;
    this.passService = passService;
    this.plans = new Map();
    this.notifications = [];
    this.seq = 0;
  }

  openPlanOf(passId) {
    return [...this.plans.values()].find((p) => p.pass_id === passId && p.status === "open");
  }

  /**
   * cause: { event_id, source: 'venue'|'transit', kind, activity_id?, connection_id?, operator?, summary }
   */
  propagate(cause, occurred_at) {
    const affected = [];
    for (const pass of this.passService.passes.values()) {
      if (pass.status !== "active") continue;
      const usesResource = cause.activity_id
        ? pass.plan.timeline.some((l) => l.kind === "activity" && l.activity_id === cause.activity_id)
        : pass.plan.timeline.some((l) => l.kind === "transit" && l.connection_id === cause.connection_id) ||
          pass.plan.returnOptions.some((o) => o.connection_id === cause.connection_id) ||
          pass.plan.chosen_return === cause.connection_id;
      const hasOpenPlan = Boolean(this.openPlanOf(pass.pass_id));
      if (!usesResource && !hasOpenPlan) continue;

      const recheck = revalidatePlan(
        this.registry,
        pass.plan,
        (activityId) => this.passService.hasAnyEntry(pass, activityId),
        pass.members.length,
      );
      pass.plan.returnOptions = recheck.returnOptions;

      if (recheck.feasible) {
        const open = this.openPlanOf(pass.pass_id);
        if (open) {
          open.status = "resolved";
          open.resolution = "资源更新后链路恢复可达";
          open.return_options = recheck.returnOptions;
        }
        continue;
      }

      const entered = pass.consumed.size > 0;
      const rule = LIABILITY_RULES[cause.source];
      const options = [];
      if (rule.rebook) options.push({ kind: "rebook", status: "offered" });
      if (rule.refundAccount(cause)) options.push({ kind: "refund", status: "offered", account: rule.refundAccount(cause) });
      if (rule.emergency_bus) options.push({ kind: "emergency_bus", status: "offered" });

      let plan = this.openPlanOf(pass.pass_id);
      if (plan) {
        plan.cause = cause;
        plan.broken = recheck.broken;
        plan.violations = recheck.violations;
        plan.options = options;
        plan.return_options = recheck.returnOptions;
      } else {
        plan = {
          plan_id: `RP-${++this.seq}`,
          pass_id: pass.pass_id,
          cause,
          broken: recheck.broken,
          violations: recheck.violations,
          entered,
          priority: entered ? "entered" : "standard",
          options,
          return_options: recheck.returnOptions,
          status: "open",
          created_at: occurred_at,
        };
        this.plans.set(plan.plan_id, plan);
        this.notifications.push({
          notification_id: `N-${this.seq}`,
          pass_id: pass.pass_id,
          channel: "app",
          status: "sent",
          sent_at: occurred_at,
          confirmed_at: null,
        });
      }

      this.store.record({
        event_type: "DELAY_PROPAGATED",
        aggregate_type: "night_pass",
        aggregate_id: pass.pass_id,
        occurred_at,
        summary: `${cause.summary} 影响联票后续计划`,
        cause,
        broken: recheck.broken,
        recovery_plan_id: plan.plan_id,
        priority: plan.priority,
      });
      affected.push(plan);
    }
    // 已入场游客优先获得可执行的返程方案
    affected.sort((a, b) => (a.priority === "entered" ? 0 : 1) - (b.priority === "entered" ? 0 : 1));
    return affected;
  }
}

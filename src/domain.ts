/** 领域事件公共信封。 */
export interface DomainEvent {
  event_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  occurred_at: string;
  version: number;
  summary: string;
}

/** 计划段：场次 / 步行换乘 / 交通班次。 */
export interface PlanLeg {
  kind: "activity" | "walk" | "transit";
  activity_id?: string;
  venue_id?: string;
  connection_id?: string;
  from?: string;
  to?: string;
  minutes?: number;
  start?: string;
  end?: string;
  depart?: string;
  arrive?: string;
  weather_fallback?: string | null;
}

/** 返程选择：散场后仍可执行的班次，末班以 is_last_service 标记。 */
export interface ReturnOption {
  connection_id: string;
  from: string;
  to: string;
  walk_min: number;
  depart: string;
  arrive: string;
  is_last_service: boolean;
}

/** CONNECTION_VALIDATED 负载：售票前链路可达性证明。 */
export interface ChainProofPayload {
  legs: PlanLeg[];
  return_options: ReturnOption[];
}

/** 延误/取消/加班的来源，用于责任判定。 */
export interface DelayCause {
  event_id: string;
  source: "venue" | "transit" | "weather" | "platform";
  kind: "delayed" | "cancelled" | "extra_added";
  activity_id?: string;
  connection_id?: string;
  operator?: string;
  summary: string;
}

/** 后继计划重算后断裂的计划段。 */
export interface BrokenLeg {
  kind: "activity" | "transit" | "return";
  id: string;
}

/** DELAY_PROPAGATED（聚合 night_pass）负载。 */
export interface DelayPropagatedPayload {
  cause: DelayCause;
  broken: BrokenLeg[];
  recovery_plan_id: string;
  priority: "entered" | "standard";
}

/** RECOVERY_CONFIRMED 负载。 */
export interface RecoveryConfirmedPayload {
  option: "rebook" | "refund" | "emergency_bus";
  result: Record<string, unknown>;
  pass_id: string;
}

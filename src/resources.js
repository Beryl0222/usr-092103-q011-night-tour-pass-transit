/**
 * 资源注册表：场馆、场次、步行换乘、交通班次。
 * 登记（add*）属于平台的基础资料维护；变更（update*）带所有权校验——
 * 场馆方只能维护自己的场次，交通方只能维护自己的班次，平台按合同可登记应急包车。
 */
export class ResourceRegistry {
  constructor(store) {
    this.store = store;
    this.venues = new Map();
    this.sessions = new Map();
    this.transit = new Map();
    this.walks = new Map();
    this.weatherAlerts = new Set();
  }

  addVenue(venue) {
    this.venues.set(venue.venue_id, {
      night_from_hour: 20,
      night_guardian_max_age: 16,
      min_age: 0,
      outdoor: false,
      indoor_fallback: null,
      ...venue,
    });
  }

  addSession(session) {
    this.sessions.set(session.activity_id, {
      late_grace_min: 0,
      night: false,
      delay_min: 0,
      cancelled: false,
      ...session,
      remaining: session.capacity,
    });
  }

  addWalk({ from, to, minutes }) {
    this.walks.set(`${from}->${to}`, minutes);
  }

  walkMinutes(from, to) {
    return this.walks.get(`${from}->${to}`);
  }

  addTransit(conn) {
    this.transit.set(conn.connection_id, { delay_min: 0, cancelled: false, ...conn, remaining: conn.capacity });
  }

  setWeatherAlert(date) {
    this.weatherAlerts.add(date);
  }

  /** 场馆方更新自己的场次：延误或取消。 */
  updateSession(actor, { activity_id, delay_min = 0, cancel = false }, occurred_at) {
    const session = this.sessions.get(activity_id);
    if (!session) throw new Error(`场次不存在：${activity_id}`);
    const venue = this.venues.get(session.venue_id);
    if (actor.role !== "venue" || actor.operator_id !== venue.owner) {
      throw new Error(`无权维护他人资源：${activity_id} 属于 ${venue.owner}`);
    }
    if (cancel) session.cancelled = true;
    session.delay_min += delay_min;
    return this.store.record({
      event_type: "DELAY_PROPAGATED",
      aggregate_type: "timed_activity",
      aggregate_id: activity_id,
      occurred_at,
      summary: cancel ? `场次取消：${activity_id}` : `场次延误 ${delay_min} 分钟：${activity_id}`,
      kind: cancel ? "cancelled" : "delayed",
      delay_min: session.delay_min,
    });
  }

  /** 交通方更新自己的班次：延误或取消。 */
  updateTransit(actor, { connection_id, delay_min = 0, cancel = false }, occurred_at) {
    const conn = this.transit.get(connection_id);
    if (!conn) throw new Error(`班次不存在：${connection_id}`);
    if (actor.role !== "transit" || actor.operator_id !== conn.operator) {
      throw new Error(`无权维护他人资源：${connection_id} 属于 ${conn.operator}`);
    }
    if (cancel) conn.cancelled = true;
    conn.delay_min += delay_min;
    return this.store.record({
      event_type: "DELAY_PROPAGATED",
      aggregate_type: "transit_connection",
      aggregate_id: connection_id,
      occurred_at,
      summary: cancel ? `班次取消：${connection_id}` : `班次延误 ${delay_min} 分钟：${connection_id}`,
      kind: cancel ? "cancelled" : "delayed",
      delay_min: conn.delay_min,
    });
  }

  /** 交通方登记临时加班班次；平台按合同登记应急包车时也走这里。 */
  addExtraTransit(actor, conn, occurred_at) {
    const own = actor.role === "transit" && actor.operator_id === conn.operator;
    if (!own && actor.role !== "platform") {
      throw new Error(`无权维护他人资源：${conn.connection_id} 属于 ${conn.operator}`);
    }
    this.addTransit(conn);
    return this.store.record({
      event_type: "DELAY_PROPAGATED",
      aggregate_type: "transit_connection",
      aggregate_id: conn.connection_id,
      occurred_at,
      summary: `临时加班班次：${conn.connection_id}`,
      kind: "extra_added",
    });
  }
}

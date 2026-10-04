import { addMinutesMs, dateOf, fmt, hourOf, toMs } from "./time.js";

/**
 * 时序计划器：把场次、步行换乘、交通班次放进同一时间轴，
 * 在售票前证明整条链路在当时可达，并给出全部可行返程选择（含末班标记）。
 */

/** 年龄与监护规则：最低年龄；夜间项目未成年人须由同行监护人陪同。 */
export function checkPartyRules(venue, session, party) {
  const violations = [];
  for (const m of party) {
    if (m.age < venue.min_age) violations.push(`成员 ${m.member_id} 未满场馆最低年龄 ${venue.min_age}`);
  }
  const isNight = session.night || hourOf(session.start) >= venue.night_from_hour;
  if (isNight) {
    for (const m of party) {
      if (m.age < venue.night_guardian_max_age) {
        const guardian = party.find((p) => p.age >= 18 && (p.guardian_of ?? []).includes(m.member_id));
        if (!guardian) violations.push(`未成年人 ${m.member_id} 参加夜间项目须由监护人同行`);
      }
    }
  }
  return violations;
}

function effectiveDepartMs(conn) {
  return addMinutesMs(toMs(conn.depart), conn.delay_min);
}

function effectiveArriveMs(conn) {
  return addMinutesMs(toMs(conn.arrive), conn.delay_min);
}

function effectiveEndMs(session) {
  return addMinutesMs(toMs(session.end), session.delay_min);
}

/** 从 node 出发、afterMs 之后可执行的返程班次（含步行衔接），按发车时间排序并标记末班。 */
export function findReturnOptions(registry, node, home, afterMs, size) {
  const options = [];
  for (const conn of registry.transit.values()) {
    if (conn.to !== home || conn.cancelled || conn.remaining < size) continue;
    let walkMin = 0;
    if (conn.from !== node) {
      const w = registry.walkMinutes(node, conn.from);
      if (w === undefined) continue;
      walkMin = w;
    }
    if (effectiveDepartMs(conn) < addMinutesMs(afterMs, walkMin)) continue;
    options.push({
      connection_id: conn.connection_id,
      from: conn.from,
      to: conn.to,
      walk_min: walkMin,
      depart: fmt(effectiveDepartMs(conn)),
      arrive: fmt(effectiveArriveMs(conn)),
    });
  }
  options.sort((a, b) => toMs(a.depart) - toMs(b.depart));
  options.forEach((o, i) => {
    o.is_last_service = i === options.length - 1;
  });
  return options;
}

/**
 * 售票前链路可达性证明。
 * request: { party: [{member_id, age, guardian_of}], legs: [...], home }
 * legs: {activity} | {walk:{from,to}} | {transit}
 * 返回 { feasible, violations, timeline, returnOptions }。
 */
export function proveChain(registry, request) {
  const { party, legs, home } = request;
  const size = party.length;
  const violations = [];
  const timeline = [];
  let t = null;
  let node = null;

  for (const leg of legs) {
    if (leg.activity) {
      const session = registry.sessions.get(leg.activity);
      if (!session) {
        violations.push(`场次不存在：${leg.activity}`);
        continue;
      }
      const venue = registry.venues.get(session.venue_id);
      if (session.cancelled) violations.push(`场次 ${session.activity_id} 已取消`);
      if (session.remaining < size) violations.push(`场次 ${session.activity_id} 容量不足`);
      violations.push(...checkPartyRules(venue, session, party));
      let weatherFallback = null;
      if (venue.outdoor && registry.weatherAlerts.has(dateOf(session.start))) {
        const alt = venue.indoor_fallback ? registry.sessions.get(venue.indoor_fallback) : null;
        if (alt && !alt.cancelled && alt.remaining >= size) weatherFallback = alt.activity_id;
        else violations.push(`户外场次 ${session.activity_id} 遇天气预警且无可用室内预案`);
      }
      const startMs = toMs(session.start);
      if (t !== null && t > addMinutesMs(startMs, session.late_grace_min)) {
        violations.push(`到达时间晚于场次 ${session.activity_id} 的允许入场时间`);
      }
      const endMs = effectiveEndMs(session);
      timeline.push({
        kind: "activity",
        activity_id: session.activity_id,
        venue_id: venue.venue_id,
        start: fmt(startMs),
        end: fmt(endMs),
        weather_fallback: weatherFallback,
      });
      t = endMs;
      node = venue.venue_id;
    } else if (leg.walk) {
      const minutes = registry.walkMinutes(leg.walk.from, leg.walk.to);
      if (minutes === undefined) {
        violations.push(`缺少 ${leg.walk.from} 到 ${leg.walk.to} 的步行换乘数据`);
        continue;
      }
      timeline.push({ kind: "walk", from: leg.walk.from, to: leg.walk.to, minutes });
      if (t !== null) t = addMinutesMs(t, minutes);
      node = leg.walk.to;
    } else if (leg.transit) {
      const conn = registry.transit.get(leg.transit);
      if (!conn) {
        violations.push(`班次不存在：${leg.transit}`);
        continue;
      }
      if (conn.cancelled) violations.push(`班次 ${conn.connection_id} 已取消`);
      if (conn.remaining < size) violations.push(`班次 ${conn.connection_id} 余票不足`);
      const depMs = effectiveDepartMs(conn);
      if (t !== null && depMs < t) violations.push(`赶不上班次 ${conn.connection_id}（${fmt(depMs)} 发车）`);
      timeline.push({
        kind: "transit",
        connection_id: conn.connection_id,
        from: conn.from,
        to: conn.to,
        depart: fmt(depMs),
        arrive: fmt(effectiveArriveMs(conn)),
      });
      t = effectiveArriveMs(conn);
      node = conn.to;
    }
  }

  let returnOptions = [];
  if (home && node) {
    returnOptions = findReturnOptions(registry, node, home, t ?? 0, size);
    if (returnOptions.length === 0) violations.push("散场后无可用返程班次（末班接驳不可达）");
  }
  return { feasible: violations.length === 0, violations, timeline, returnOptions };
}

/**
 * 后继计划重算：资源变更（延误/取消/加班）后，沿原计划时间轴重新校验。
 * 已入场的场次只跟随其散场时间变化，不再重复校验容量与资格。
 */
export function revalidatePlan(registry, plan, isConsumed, size) {
  const violations = [];
  const broken = [];
  let t = null;
  let node = null;

  for (const leg of plan.timeline) {
    if (leg.kind === "activity") {
      const session = registry.sessions.get(leg.activity_id);
      if (!session) {
        violations.push(`场次不存在：${leg.activity_id}`);
        broken.push({ kind: "activity", id: leg.activity_id });
        continue;
      }
      if (!isConsumed(leg.activity_id)) {
        if (session.cancelled) {
          violations.push(`场次 ${leg.activity_id} 已取消`);
          broken.push({ kind: "activity", id: leg.activity_id });
        }
        if (t !== null && t > addMinutesMs(toMs(session.start), session.late_grace_min)) {
          violations.push(`衔接失败：无法在场次 ${leg.activity_id} 入场截止前到达`);
          broken.push({ kind: "activity", id: leg.activity_id });
        }
      }
      t = effectiveEndMs(session);
      node = session.venue_id;
    } else if (leg.kind === "walk") {
      const minutes = registry.walkMinutes(leg.from, leg.to);
      if (minutes === undefined) {
        violations.push(`缺少 ${leg.from} 到 ${leg.to} 的步行换乘数据`);
        continue;
      }
      if (t !== null) t = addMinutesMs(t, minutes);
      node = leg.to;
    } else if (leg.kind === "transit") {
      const conn = registry.transit.get(leg.connection_id);
      if (!conn || conn.cancelled) {
        violations.push(`班次 ${leg.connection_id} 已取消`);
        broken.push({ kind: "transit", id: leg.connection_id });
        node = leg.to;
        continue;
      }
      if (t !== null && effectiveDepartMs(conn) < t) {
        violations.push(`赶不上班次 ${leg.connection_id}`);
        broken.push({ kind: "transit", id: leg.connection_id });
      }
      t = effectiveArriveMs(conn);
      node = conn.to;
    }
  }

  let returnOptions = [];
  if (plan.home && node) {
    returnOptions = findReturnOptions(registry, node, plan.home, t ?? 0, size);
    if (returnOptions.length === 0) {
      violations.push("散场后无可用返程班次（末班接驳不可达）");
      broken.push({ kind: "return", id: plan.home });
    }
  }
  return { feasible: violations.length === 0, violations, broken, returnOptions };
}

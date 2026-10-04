import { EventStore } from "./eventStore.js";
import { ResourceRegistry } from "./resources.js";
import { PassService } from "./passes.js";
import { PropagationEngine } from "./propagation.js";
import { RecoveryService } from "./recovery.js";
import { confirmNotification, dutyBoard, visitorTimeline } from "./views.js";

/**
 * 组合根：把事件存储、资源注册、联票、传播引擎、补救服务接成一个后端。
 * 外部更新（场馆延误/取消、班次延误/取消/加班）经 apply* 入口进入，
 * 先落版本化事件，再沿后继计划传播。
 */
export function createSystem() {
  const store = new EventStore();
  const registry = new ResourceRegistry(store);
  const passes = new PassService(store, registry);
  const engine = new PropagationEngine(store, registry, passes);
  const recovery = new RecoveryService(store, registry, passes, engine);

  return {
    store,
    registry,
    passes,
    engine,
    recovery,

    applySessionUpdate(actor, args, occurredAt) {
      const event = registry.updateSession(actor, args, occurredAt);
      const session = registry.sessions.get(args.activity_id);
      const venue = registry.venues.get(session.venue_id);
      return engine.propagate(
        {
          event_id: event.event_id,
          source: "venue",
          kind: event.kind,
          activity_id: args.activity_id,
          operator: venue.owner,
          summary: event.summary,
        },
        occurredAt,
      );
    },

    applyTransitUpdate(actor, args, occurredAt) {
      const event = registry.updateTransit(actor, args, occurredAt);
      return engine.propagate(
        {
          event_id: event.event_id,
          source: "transit",
          kind: event.kind,
          connection_id: args.connection_id,
          operator: registry.transit.get(args.connection_id).operator,
          summary: event.summary,
        },
        occurredAt,
      );
    },

    addExtraTransit(actor, conn, occurredAt) {
      const event = registry.addExtraTransit(actor, conn, occurredAt);
      return engine.propagate(
        {
          event_id: event.event_id,
          source: "transit",
          kind: "extra_added",
          connection_id: conn.connection_id,
          operator: conn.operator,
          summary: event.summary,
        },
        occurredAt,
      );
    },

    visitorTimeline: (passId) => visitorTimeline(passes, engine, passId),
    dutyBoard: (causeEventId) => dutyBoard(engine, passes, causeEventId),
    confirmNotification: (id, delivered, at) => confirmNotification(engine, id, delivered, at),
  };
}

import { validateEvent } from "./validator.js";

/**
 * 事件存储：每个聚合的版本单调递增。
 * 内部用 record() 自动取下一版本；外部更新必须走 submit() 并携带正确的下一版本号，
 * 以此作为跨模块协作的乐观并发约定。
 */
export class EventStore {
  #events = [];
  #versions = new Map();

  versionOf(aggregateId) {
    return this.#versions.get(aggregateId) ?? 0;
  }

  /** 外部更新入口：事件必须自带 version，且必须等于当前版本 + 1。 */
  submit(event) {
    const errors = validateEvent(event);
    if (errors.length > 0) throw new Error(`事件不符合约定：${errors.join("；")}`);
    const expected = this.versionOf(event.aggregate_id) + 1;
    if (event.version !== expected) {
      throw new Error(`版本冲突：聚合 ${event.aggregate_id} 期望版本 ${expected}，收到 ${event.version}`);
    }
    this.#events.push(event);
    this.#versions.set(event.aggregate_id, event.version);
    return event;
  }

  /** 内部写入入口：自动分配下一版本号。 */
  record(fields) {
    const version = this.versionOf(fields.aggregate_id) + 1;
    return this.submit({ event_id: `${fields.aggregate_id}#${version}`, ...fields, version });
  }

  eventsOf(aggregateId) {
    return this.#events.filter((e) => e.aggregate_id === aggregateId);
  }

  all() {
    return [...this.#events];
  }
}

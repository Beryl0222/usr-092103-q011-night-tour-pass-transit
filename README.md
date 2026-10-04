# 夜游联票与末班接驳

本仓库保存夜游联票与末班接驳的领域词汇、交换事件与中文联调样例，并提供联票与接驳协调后端的核心实现：场次、步行换乘、交通班次、场馆容量、年龄限制、户外条件预案、联票权益、验票记录和散场预测被放入同一时序计划。

## 资料结构

- `contracts/domain.schema.json`：领域事件的公共信封与稳定枚举。
- `data/sample.json`：一条最小业务事件样例。
- `src/`：公共字段校验与协调后端核心模块。
- `tests/`：基础约定测试与核心业务不变量测试。

## 后端模块

- `src/eventStore.js`：事件存储。每个聚合版本单调递增；外部更新必须经 `submit()` 携带正确的下一版本号，否则按版本冲突拒绝。
- `src/resources.js`：资源注册（场馆、场次、步行换乘、班次）。登记属平台基础资料；变更带所有权校验——场馆方只能维护自己的场次，交通方只能维护自己的班次，平台按合同登记应急包车。
- `src/planner.js`：时序计划器。`proveChain` 在售票前证明整条链路在当时可达（场次衔接、步行换乘、班次、容量、年龄与监护、户外天气预案、末班返程）；`revalidatePlan` 在资源变更后沿后继计划重算。
- `src/passes.js`：联票出票与核销。证明通过才出票并锁定沿途容量；权益按 联票×场次×成员 核销，多点扫码与离线闸机补传只判重复、不二次消耗；未成年人夜间项目须监护人同场核验。
- `src/propagation.js`：传播引擎。场馆延误、班次取消或临时加班沿受影响联票的后继计划传播，已入场游客标记最高优先级；加班资源使计划恢复可达时未结补救计划自动关闭。
- `src/recovery.js`：补救服务。退款、改签、应急包车按责任来源（场馆/交通/天气/平台）与合同规则开放，确认后执行权益与容量转移。
- `src/views.js`：读侧视图。游客时间线（下一站、最后返程选择、补救选项）与值班看板（受影响人员、补救进展、通知送达确认）。
- `src/index.js`：组合根，外部更新经 `applySessionUpdate` / `applyTransitUpdate` / `addExtraTransit` 进入。

## 事件类型使用

| 事件类型 | 聚合 | 含义 |
| --- | --- | --- |
| PASS_ISSUED | night_pass | 链路证明通过后出票 |
| CONNECTION_VALIDATED | night_pass | 售票前链路可达性证明（负载含时间轴与返程选项） |
| ENTRY_RECORDED | night_pass | 单次核销（含离线闸机补传标记） |
| DELAY_PROPAGATED | timed_activity / transit_connection / night_pass | 资源变更登记及其向后续计划的传播 |
| RECOVERY_CONFIRMED | recovery_plan | 补救方案确认（退款/改签/应急包车） |

## 本地检查

```bash
npm test
```

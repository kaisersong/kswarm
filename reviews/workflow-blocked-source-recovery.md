# PO task workflow 阻塞与源任务状态同步

真实证据：worker 已完成 Markdown，reviewer 因整个 run 的已批准墙钟期限停止。run=blocked，但源任务仍 dispatched、持有 workflow lease，projectIntervention.required=false。legacy watchdog 已正确让渡 workflow 所有权，因此不能再依赖错误的旧 watchdog 把它退回。

设计：Hub 所有运行态 workflow 写回使用一个窄 storeWorkflowRun(run) owner。先保留 run，再同步它拥有的源任务：仅 workflowId=po-generated-task-workflow、source=po_generated、status=blocked/failed，scope 的 canonical taskId 必须在同 project board 中，源任务仍处于 dispatched/accepted/in_progress，activeRunId 必须精确等于 workflow-${run.id}。通过既有 board.blockTask 进入 blocked，关闭 lease、保留 lastRunLease，标准 blockKind=workflow_blocked，不自动重试、不提交/验收、不复制未评审 worker output 为 task.result。重复、旧 run、其他项目/任务、script/project workflow、submitted/done 均无作用。

所有运行态 Map.set 收敛到 store；初始原样反序列化保留。现有 recoverInterruptedTaskWorkflows 对已存的 blocked/failed PO task run 同样执行该幂等同步，覆盖旧悬挂源任务，按既有 full mutation scope 持久化。普通运行中任务的中断取消与 pending 恢复不变。各 run-keyed 方法已有 project mutation scope（包含 board），不新增通用任务写入口。

已完成 worker 节点及其产物始终留在原 run；旧失败 gate 不改成通过。恢复只使用既有 intervention/resolve 的 repair_and_submit 文件入口：重新校验 artifacts 路径、内容与 expectedTaskUpdatedAt，进入 submitted 后由真实 PO 复审；不能直接 done。原产物可作为未验收材料复用，不重新执行成功 worker，不重置旧 run deadline。

验证：真实 Hub dispatch→worker output→review runtime unavailable 的 RED/GREEN；worker unavailable、malformed/blocked review 兄弟入口；intervention出现、下游保持pending、lease关闭；重复和旧run不得覆盖新owner；project/script和submitted/done不受影响；SQLite保存重开后恢复旧 blocked run/source lease；实际文件 repair_and_submit 只到submitted、真实 review queue 接手。既有 workflow、watchdog、task board、intervention测试及全套npm test/test:all。源码/安装/实际项目分别验收。

## 已执行验证与独立评审

- gpt-6-astra 独立设计 APPROVE 后进入真实 Hub 回归；15 项中 7 项在旧实现 RED（源任务仍 dispatched），实现后 15/15 GREEN。
- `npm test`、`npm run test:all` 均退出 0；新文件已接入 test:workflow/test:all。
- 全部 21 处运行态写回收敛。SQLite 回归暴露额外 task.blocked 会超出现有 activity critical reservation；实现沿既有 workflow event 与同次 durable snapshot 更新，未放宽 reservation 或 schema。初始反序列化保持原样，恢复 mutation 同步旧不一致状态。
- 真实 manifest→恢复 submitted→调用 review 通知接口由测试覆盖；通知使用记录回调，尚不能证明实际 broker/PO 收到或完成，真实项目另验。
- 独立模型 gpt-6-astra 对当前代码 CODE APPROVE，未运行测试；提交完整 HEAD 后仍需确认。本机安装与项目恢复另行记录，非发布批准。

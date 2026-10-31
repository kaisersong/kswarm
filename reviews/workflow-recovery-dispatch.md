# 工作流恢复投递缺口修复

## 已核实的事故链

生产项目的执行器首次返回 reasoning admission 错误，被包装为 `desktop_runtime_error`。Hub 更换执行器后，策略切换到任务工作流，返回 `replacementDispatch.workflowNodeDispatches`，但失败入口只提取 `replacementDispatched` 对应普通 task ID，丢弃节点 handoff。Hub 已持久化 running 节点，因此形成“已派发但无执行回执”，任务 watchdog 后又回到 pending。

当前 Desktop 已安装的模型准入恢复和默认模型通过真实无工具请求验证；不重写已经修复的模型入口。真实项目的数据和原始错误仅保存在本机私有诊断目录，测试使用虚构材料。

## 设计

1. 复用既有普通任务和 workflow node 两个 transport，由单个投递函数接收生产 dispatch DTO。只投递 `ok:true`，分别转发 direct IDs 和完整 node handoff，不把工作流当普通任务。
2. 失败恢复提取普通 retry/replacement IDs 及成功 replacementDispatch 的 workflowNodeDispatches。覆盖 broker task_failed、HTTP fail、投递失败、watchdog；其它同样会丢弃 adaptive workflow 的入口（启动恢复、continue、reassign、backoff sweep）一起接入。
3. continue 的两条 retry 分支保留 workflowDispatched 和 workflowNodeDispatches。原有幂等、依赖、权限、验收和外部副作用限制不变；不增加恢复权限，不改 IPC、持久化 schema 或模型配置。
4. 一个 transport 抛错不应阻止另一个开始投递，收集全部结果后保留错误；既有 handoff 失败继续由原 owner 收敛为 blocked。不以“已创建 running”作为真实执行成功。
5. 真实事故先用已有用户入口取消已核实无执行回执的旧 workflow，再经正常 dispatch 重新推进；保留已完成产物、失败记录和取消原因，不改写 JSON/SQLite。

## 实现前对抗性自审

- 只修 task_failed 仍可从 HTTP fail、投递失败和 watchdog 重现：统一全部 failureRecoveryTaskIds 调用人口。
- 只透传 continue 的 DTO，HTTP owner 仍不发 node：producer 和 transport 两侧都测。
- direct 分支空数组不等于无恢复工作；startup 与 backoff 的条件必须检查 workflowNodeDispatches。
- 不对断线中的未知执行者自动重放；此次仅修漏投递。已运行的脚本、workspace claim 不转移 owner，不做全局取消或重置。
- 测试必须用真实 Hub 生成的 adaptive workflow 结果，并调用生产投递函数，验证 node/handoff/attempt 原样到达 transport；源码 contract 仅补充检查所有入口已接线。
- `allSettled` 不能吞错并返回成功：完成两类 transport 后聚合失败，caller 的原错误路径继续可见。
- continue 幂等回执保留描述供展示，但不能把缓存回执再次作为新投递执行；统一 owner 对 `idempotent:true` 不重复发送，重试失败仍走原状态恢复路径。

结论：按上述范围实施。该评审为实施者自审，未冒充独立模型批准；PR 保持草稿供质量最终 HEAD 复验。

## 验证计划

RED/GREEN：真实 Hub 的自动改派转工作流、continue 重试、普通 retry、混合 transport 失败不相互饿死；各失败入口接线 contract；相关 workflow、failure recovery、project continue、persistence、dispatch 与 broker delivery 回归。真实安装服务验证节点收到 started、产生实际产物、依赖任务继续解锁；构建/提交/安装/项目完成分开记录。

## 本地验证

- `node --test test/project-continue-workflow.test.js`：旧代码两项均因丢失 workflowDispatched 失败；修复后 root/已有 retry child 均通过。
- `node --test test/project-continue-workflow.test.js test/task-dispatch-delivery.test.js test/failure-recovery-dispatch.test.js`：10/10 通过；其中恢复描述幂等回执重复投递曾实测 RED，修复后只发送一次。
- `node test/server-failure-class-contract.test.js`：4/4 通过，涵盖全部投递失败、broker/HTTP failure、watchdog、startup、continue、reassign、backoff 入口。
- `node test/project-continue.test.js`：22/22；`node test/workflow-task-strategy.test.js`：8/8。
- `npm test`、`npm run test:all`：退出码 0。新增行为测试已接入 test:workflow 与 test:all，无新增依赖。
- `node --check src/server/index.js` 通过。
- 用户项目恢复经已有语义 API，旧 run 保留取消原因，新的 handoff 得到 broker 在线投递回执和 Desktop 的 started 回执。随后的真实执行暴露独立的模型终止边界错误；不能把该次 started 当项目完成。模型修复在单独 xiaok-cli 分支验证，真实项目继续验收另记本机私有日志，不将用户材料提交仓库。

## 第三轮：两个 watchdog 的工作流所有权

真实写文件恢复后，复查发现 run-watchdog 已跳过 workflow-owned source task，但仍并行运行的 legacy watchdog 不检查所有权，10 分钟后可以把合法 worker→review 流程的 source task 重置到 pending，丢失 activeRunId。原项目里出现过这种回退；不能只修其中一个 watchdog。

设计与实施前对抗性自审：复用 run-watchdog 既有 isWorkflowOwnedTask 判定，legacy owner 同样跳过 workflow task；普通 direct task 保持既有超时行为。只消除两个 owner 的竞争，不扩大执行预算、不把 blocked 当成功、不自动审批，不新增重试。用真实 Hub 生成工作流派发，运行真实 legacy watchdog 超过 timeout 并核对 source status/run ID 原样保留；先 RED 再 production。安装须等当前节点安全边界，不能为装补丁中断正在生成的交付物。

## 第四轮：评审通过后的 PO 交接

真实工作流 worker→review→gate 已全部 completed，源任务停在 submitted，且没有执行中的任务。项目只提供手动 notify_po_review 继续入口。核实 broker workflow_node_result 仅广播与发下游 node，不像普通 submit_result 那样调用持久 review queue，导致后续依赖仍等待。

设计与实施前对抗性自审：对成功完成且 taskSubmission.status=submitted 的生产 workflow receipt，从当前 Hub board 读取同一 scope task 的真实 result，交给既有 deliverReviewSubmission 持久队列；不把 workflow reviewer 的通过当作 PO 验收，不改 done/依赖或审批规则。失败、blocked、already_submitted、task/run identity 不符均不得发送。此源任务工作流仅从 broker review 入口完成；script HTTP result 不产生该 receipt，不增加路由权限。测试真实 Hub 完成及真实产物证据，确认正确项目/任务/run 提交被送入既有 queue；源码 contract 仅辅助确认生产入口接线。

第三/四轮验证：真实 Hub watchdog 场景先 RED（错误 reset→pending），修复后 source status/run identity 原样保留；工作流到 PO queue 的生产入口 contract 先 RED，真实 Hub 完成+artifact 的 transport 回归通过（按真实 provenance.workflowRunId 绑定）。最终行为用例 12/12，server contract 5/5，legacy watchdog 19/19、runtime watchdog 12/12；npm test 与 npm run test:all 均退出 0。两个新增场景接入 test:workflow/test:all。真实项目 worker 写入/回读与 workflow review/gate 已完成；PO 验收通知及后续依赖的本地验收继续进行，不把 submitted 当 done。

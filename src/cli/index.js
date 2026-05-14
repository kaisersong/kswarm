#!/usr/bin/env node
/**
 * KSwarm CLI — 入口
 *
 * Commands:
 *   kswarm new "目标" --po @agent   创建项目
 *   kswarm status                   查看看板
 *   kswarm approve                  审批计划
 *   kswarm log                      查看事件流
 */

import { createHub } from '../core/hub.js';
import { renderStatus, renderTimeline, renderOneLiner } from './status.js';

const args = process.argv.slice(2);
const command = args[0];

// Hub 实例（进程内，后续改为连接 daemon）
let hub = null;
let currentProjectId = null;

function getHub() {
  if (!hub) {
    hub = createHub({ silent: false });
  }
  return hub;
}

function usage() {
  console.log(`
  KSwarm — Agent Swarm Hub

  Usage:
    kswarm new "目标" --po @agent    创建项目并指定 PO
    kswarm status                    查看项目看板
    kswarm approve [projectId]       审批计划
    kswarm log [projectId]           查看事件日志
    kswarm verify                    运行端到端验证

  KSwarm 是 Hub，不是 Brain。
  它只做：路由、看板、门控。
  业务决策由 PO Agent 完成。
`);
}

if (!command || command === '--help' || command === '-h') {
  usage();
  process.exit(0);
}

// For now, only 'verify' is fully implemented (self-contained verification)
if (command === 'verify') {
  const { runVerification } = await import('./verify.js');
  await runVerification();
} else {
  console.log(`  命令 "${command}" 需要 Hub daemon 运行。`);
  console.log(`  当前可用: kswarm verify（自包含验证）`);
  console.log(`  运行 kswarm --help 查看所有命令。`);
}

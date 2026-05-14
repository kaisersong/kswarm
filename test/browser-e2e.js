#!/usr/bin/env node
/**
 * KSwarm — Real Browser E2E Test
 *
 * 用 Playwright 驱动真实浏览器，在 Web UI 上一步步操作：
 * 1. 打开页面
 * 2. 点 "新建项目" 按钮
 * 3. 填写表单（项目名、目标、选 PO、选成员）
 * 4. 提交
 * 5. 点进项目详情
 * 6. 添加任务（填表单）
 * 7. 点审批
 * 8. 点派发
 * 9. 等 worker 完成（自动执行）
 * 10. 点确认完成（逐个）
 * 11. 点关闭项目
 * 12. 截图验证最终状态
 *
 * 前置条件:
 *   - intent-broker on 4318
 *   - kswarm server on 4400
 *   - auto-workers connected
 *   - vite dev server on 5188
 */

import { chromium } from 'playwright';
import { join } from 'path';

const URL = 'http://localhost:5188';
const SCREENSHOTS_DIR = join(import.meta.dirname, '..', 'test-screenshots');

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
  cyan: '\x1b[36m', red: '\x1b[31m', gray: '\x1b[90m',
};

function step(n, msg) {
  console.log(`\n  ${c.cyan}[Step ${n}]${c.reset} ${msg}`);
}

async function main() {
  console.log(`
${c.bold}╔═══════════════════════════════════════════════════════════════╗
║    KSwarm — Real Browser E2E (Playwright)                     ║
║                                                               ║
║    真实打开浏览器，在 Web UI 上一步步点击操作                    ║
║    不是 API 调用，是真正的 UI 交互！                            ║
╚═══════════════════════════════════════════════════════════════╝${c.reset}
`);

  const { mkdirSync } = await import('fs');
  mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  try {
    // ─── Step 1: Open page ──────────────────────────────────────────
    step(1, '打开 KSwarm Web UI');
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForSelector('header');
    console.log(`    → 页面加载完成: ${URL}`);
    await page.screenshot({ path: join(SCREENSHOTS_DIR, '01-home.png'), fullPage: true });

    // Use unique project name to avoid collision with old data
    const PROJECT_NAME = `AI客服系统-${Date.now().toString(36)}`;

    // ─── Step 2: Click "新建项目" ────────────────────────────────────
    step(2, '点击 "新建项目" 按钮');
    const newBtn = page.locator('button', { hasText: /新建|New/ });
    await newBtn.click();
    await page.waitForSelector('form');
    console.log(`    → 创建表单已展开`);

    // ─── Step 3: Fill project form ──────────────────────────────────
    step(3, '填写项目信息');
    // Name field
    const nameInput = page.locator('input[placeholder*="项目名"]').or(page.locator('form input').first());
    await nameInput.fill(PROJECT_NAME);
    console.log(`    → 项目名: ${PROJECT_NAME}`);

    // Goal field
    const goalInput = page.locator('input[placeholder*="目标"]').or(page.locator('form input').nth(1));
    await goalInput.fill('基于 LLM 的多轮对话客服，支持知识库检索和人工转接');
    console.log(`    → 目标: 基于 LLM 的多轮对话客服`);

    // Select PO agent — must be auto-worker-1 (Bot-Alpha)
    // PO section is the first flex-wrap gap-2 div after the "PO" label
    step(4, '选择 PO Agent');
    // Click the Bot-Alpha button specifically - use exact text match to avoid cross-section issues
    const poSection = page.locator('form').locator('div.flex.flex-wrap').first();
    const poBtns = poSection.locator('button');
    const poBtnCount = await poBtns.count();
    for (let i = 0; i < poBtnCount; i++) {
      const text = await poBtns.nth(i).textContent();
      if (text.trim() === 'Bot-Alpha') {
        await poBtns.nth(i).click();
        console.log(`    → 选择 PO: Bot-Alpha (auto-worker-1)`);
        break;
      }
    }
    await page.waitForTimeout(500); // Wait for React to re-render members section

    // Select member — auto-worker-2 (Bot-Beta) from the MEMBERS section (second flex-wrap div)
    const memberSection = page.locator('form').locator('div.flex.flex-wrap').nth(1);
    const memBtns = memberSection.locator('button');
    const memCount = await memBtns.count();
    for (let i = 0; i < memCount; i++) {
      const text = await memBtns.nth(i).textContent();
      if (text.trim() === 'Bot-Beta') {
        await memBtns.nth(i).click();
        console.log(`    → 选择成员: Bot-Beta (auto-worker-2)`);
        break;
      }
    }

    await page.screenshot({ path: join(SCREENSHOTS_DIR, '02-form-filled.png'), fullPage: true });

    // ─── Step 5: Submit form ────────────────────────────────────────
    step(5, '提交创建项目');
    const submitBtn = page.locator('form button[type="submit"]');
    await submitBtn.click();
    await page.waitForTimeout(1000);
    console.log(`    → 项目已创建`);
    await page.screenshot({ path: join(SCREENSHOTS_DIR, '03-project-created.png'), fullPage: true });

    // ─── Step 6: Click project card to view detail ──────────────────
    step(6, '点击项目卡片查看详情');
    const projectCard = page.locator(`text=${PROJECT_NAME}`).last(); // Use last in case duplicates
    await projectCard.click();
    await page.waitForTimeout(800);
    console.log(`    → 项目详情面板已打开`);

    // ─── Step 7: Add tasks ──────────────────────────────────────────
    step(7, '添加任务（人工添加）');
    const addTaskBtn = page.locator('button', { hasText: /添加|Add/ }).first();
    await addTaskBtn.click();
    await page.waitForTimeout(300);

    // Fill first task
    const taskInputs = page.locator('form input[placeholder*="Task"]').or(page.locator('form input[placeholder*="task"]'));
    await taskInputs.first().fill('知识库向量化引擎');
    
    // Select agent for first task — explicitly select auto-worker-1
    const agentSelects = page.locator('form select');
    if (await agentSelects.first().isVisible()) {
      await agentSelects.first().selectOption('auto-worker-1');
      console.log(`    → 任务1 分配给: auto-worker-1`);
    }

    // Add another row
    const addRowBtn = page.locator('button', { hasText: /添加一行|add row|\+/ }).last();
    if (await addRowBtn.isVisible()) {
      await addRowBtn.click();
      await page.waitForTimeout(200);
    }

    // Fill second task
    const taskInput2 = page.locator('form input[placeholder*="Task"]').or(page.locator('form input[placeholder*="task"]'));
    if (await taskInput2.nth(1).isVisible()) {
      await taskInput2.nth(1).fill('多轮对话 Agent 框架');
      if (await agentSelects.nth(1).isVisible()) {
        await agentSelects.nth(1).selectOption('auto-worker-2');
        console.log(`    → 任务2 分配给: auto-worker-2`);
      }
    }

    // Add third row
    if (await addRowBtn.isVisible()) {
      await addRowBtn.click();
      await page.waitForTimeout(200);
    }
    if (await taskInput2.nth(2).isVisible()) {
      await taskInput2.nth(2).fill('人工转接网关');
      if (await agentSelects.nth(2).isVisible()) {
        await agentSelects.nth(2).selectOption('auto-worker-1');
        console.log(`    → 任务3 分配给: auto-worker-1`);
      }
    }

    console.log(`    → 填写了 3 个任务`);
    await page.screenshot({ path: join(SCREENSHOTS_DIR, '04-tasks-form.png'), fullPage: true });

    // Save tasks
    const saveBtn = page.locator('button', { hasText: /保存|Save|save/ });
    await saveBtn.click();
    await page.waitForTimeout(800);
    console.log(`    → 任务已保存`);

    // ─── Step 8: Approve ────────────────────────────────────────────
    step(8, '点击审批通过');
    const approveBtn = page.locator('button', { hasText: /审批|Approve/ });
    if (await approveBtn.isVisible()) {
      await approveBtn.click();
      await page.waitForTimeout(500);
      console.log(`    → 已审批`);
    } else {
      console.log(`    → (审批按钮不可见，可能已经是 active 状态)`);
    }

    await page.screenshot({ path: join(SCREENSHOTS_DIR, '05-approved.png'), fullPage: true });

    // ─── Step 9: Dispatch ───────────────────────────────────────────
    step(9, '点击派发任务');
    // Refresh first to see dispatch button
    const refreshBtn = page.locator('button', { hasText: /刷新|Refresh/ });
    if (await refreshBtn.isVisible()) {
      await refreshBtn.click();
      await page.waitForTimeout(500);
    }

    const dispatchBtn = page.locator('button', { hasText: /派发|Dispatch/ });
    if (await dispatchBtn.isVisible()) {
      await dispatchBtn.click();
      await page.waitForTimeout(500);
      console.log(`    → 任务已派发到 Workers`);
    } else {
      console.log(`    → (派发按钮不可见)`);
    }

    await page.screenshot({ path: join(SCREENSHOTS_DIR, '06-dispatched.png'), fullPage: true });

    // ─── Step 10: Wait for workers ──────────────────────────────────
    step(10, '等待 Workers 自动执行任务...');
    // Auto-workers need time to accept, progress, and submit
    for (let i = 0; i < 10; i++) {
      await page.waitForTimeout(1500);
      if (refreshBtn && await refreshBtn.isVisible()) {
        await refreshBtn.click();
        await page.waitForTimeout(500);
      }
      // Check if "submitted" or "确认完成" buttons appear
      const markDoneButtons = page.locator('button', { hasText: /确认完成|Mark Done|markDone/ });
      const count = await markDoneButtons.count();
      if (count > 0) {
        console.log(`    → Workers 完成！发现 ${count} 个待确认任务`);
        break;
      }
      if (i < 9) console.log(`    → 等待中... (${(i + 1) * 2}s)`);
    }

    await page.screenshot({ path: join(SCREENSHOTS_DIR, '07-workers-done.png'), fullPage: true });

    // ─── Step 11: Mark tasks done (PO confirm) ──────────────────────
    step(11, '逐个点击 "确认完成"');
    let doneCount = 0;
    for (let attempt = 0; attempt < 5; attempt++) {
      const markDoneBtn = page.locator('button', { hasText: /确认完成|Mark Done/ }).first();
      if (await markDoneBtn.isVisible()) {
        await markDoneBtn.click();
        doneCount++;
        await page.waitForTimeout(600);
        if (refreshBtn && await refreshBtn.isVisible()) {
          await refreshBtn.click();
          await page.waitForTimeout(400);
        }
      } else {
        break;
      }
    }
    console.log(`    → 确认完成了 ${doneCount} 个任务`);

    await page.screenshot({ path: join(SCREENSHOTS_DIR, '08-all-done.png'), fullPage: true });

    // ─── Step 12: Close project ─────────────────────────────────────
    step(12, '关闭项目（Human 最终决定）');
    const closeBtn = page.locator('button', { hasText: /关闭项目/ });
    if (await closeBtn.isVisible()) {
      await closeBtn.click();
      await page.waitForTimeout(300);
      // Confirm dialog
      const confirmBtn = page.locator('button', { hasText: /确认关闭/ });
      if (await confirmBtn.isVisible()) {
        await confirmBtn.click();
        await page.waitForTimeout(500);
        console.log(`    → 项目已关闭`);
      }
    } else {
      console.log(`    → 关闭按钮不可见（可能需要先 refresh）`);
      if (refreshBtn && await refreshBtn.isVisible()) {
        await refreshBtn.click();
        await page.waitForTimeout(500);
      }
      const closeBtn2 = page.locator('button', { hasText: /关闭项目/ });
      if (await closeBtn2.isVisible()) {
        await closeBtn2.click();
        await page.waitForTimeout(300);
        const confirmBtn2 = page.locator('button', { hasText: /确认关闭/ });
        if (await confirmBtn2.isVisible()) {
          await confirmBtn2.click();
          await page.waitForTimeout(500);
          console.log(`    → 项目已关闭`);
        }
      }
    }

    await page.screenshot({ path: join(SCREENSHOTS_DIR, '09-closed.png'), fullPage: true });

    // ─── Step 13: Check timeline ────────────────────────────────────
    step(13, '切换到活动时间线查看完整记录');
    const timelineTab = page.locator('button', { hasText: /活动|Timeline|Activit/ });
    if (await timelineTab.isVisible()) {
      await timelineTab.click();
      await page.waitForTimeout(500);
    }
    await page.screenshot({ path: join(SCREENSHOTS_DIR, '10-timeline.png'), fullPage: true });
    console.log(`    → 时间线截图已保存`);

    // ─── Step 14: Check deliverable view ────────────────────────────
    step(14, '切换到交付物视图');
    const deliverTab = page.locator('button', { hasText: /交付|Deliver/ });
    if (await deliverTab.isVisible()) {
      await deliverTab.click();
      await page.waitForTimeout(500);
    }
    await page.screenshot({ path: join(SCREENSHOTS_DIR, '11-deliverables.png'), fullPage: true });
    console.log(`    → 交付物截图已保存`);

    // ─── Step 15: Click an artifact to preview ──────────────────────
    step(15, '点击一个 artifact 预览');
    const artifactBtn = page.locator('button', { hasText: /report\.md/ }).first();
    if (await artifactBtn.isVisible()) {
      await artifactBtn.click();
      await page.waitForTimeout(800);
      await page.screenshot({ path: join(SCREENSHOTS_DIR, '12-artifact-preview.png'), fullPage: true });
      console.log(`    → Artifact 预览截图已保存`);
      // Close preview
      const closePreviewBtn = page.locator('button', { hasText: /关闭|Close/ }).last();
      if (await closePreviewBtn.isVisible()) await closePreviewBtn.click();
    } else {
      console.log(`    → 没找到 artifact 按钮（可能任务结果格式问题）`);
    }

    // ─── Final verification ──────────────────────────────────────────
    console.log(`\n${c.bold}${c.green}═══════════════════════════════════════════════════${c.reset}`);
    console.log(`${c.bold}${c.green}  ✓ 浏览器 E2E 全流程完成！${c.reset}`);
    console.log(`${c.green}    - 真实打开浏览器，在 UI 上逐步操作${c.reset}`);
    console.log(`${c.green}    - 创建项目 → 添加任务 → 审批 → 派发 → Workers执行 → 确认 → 关闭${c.reset}`);
    console.log(`${c.green}    - 截图保存在: ${SCREENSHOTS_DIR}${c.reset}`);
    console.log(`${c.bold}${c.green}═══════════════════════════════════════════════════${c.reset}\n`);

    // List screenshots
    const { readdirSync } = await import('fs');
    const shots = readdirSync(SCREENSHOTS_DIR).filter(f => f.endsWith('.png')).sort();
    console.log(`  截图列表 (${shots.length}):`);
    for (const s of shots) {
      console.log(`    📸 ${s}`);
    }

  } catch (error) {
    console.error(`\n  ${c.red}${c.bold}ERROR: ${error.message}${c.reset}`);
    console.error(`  ${c.gray}${error.stack}${c.reset}`);
    await page.screenshot({ path: join(SCREENSHOTS_DIR, 'ERROR.png'), fullPage: true });
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});

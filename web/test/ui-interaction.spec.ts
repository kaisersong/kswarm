/**
 * UI interaction tests for kswarm standalone web app.
 * Uses data-testid attributes for reliable element selection.
 *
 * Run: npx playwright test test/ui-interaction.spec.ts
 * Requires: dev server running on port 5188
 */

import { test, expect } from '@playwright/test';

const BASE = 'http://localhost:5188';

test.describe('KSwarm UI interactions', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);
  });

  test('can switch between Projects and Agents tabs', async ({ page }) => {
    const projectsTab = page.getByTestId('tab-projects');
    const agentsTab = page.getByTestId('tab-agents');
    await expect(projectsTab).toBeVisible();
    await expect(agentsTab).toBeVisible();

    await agentsTab.click();
    await page.waitForTimeout(500);
    await expect(agentsTab).toHaveClass(/border-gray-900/);

    await projectsTab.click();
    await page.waitForTimeout(500);
    await expect(projectsTab).toHaveClass(/border-gray-900/);
  });

  test('can open and close create project modal', async ({ page }) => {
    await page.getByTestId('btn-create-project').click();
    await page.waitForTimeout(500);
    await expect(page.getByTestId('modal-create-project')).toBeVisible();

    await page.getByRole('button', { name: '取消' }).click();
    await page.waitForTimeout(500);
    await expect(page.getByTestId('modal-create-project')).not.toBeVisible();
  });

  test('can type in create project form fields', async ({ page }) => {
    await page.getByTestId('btn-create-project').click();
    await page.waitForTimeout(500);

    await page.getByTestId('input-project-name').fill('UI测试项目');
    await expect(page.getByTestId('input-project-name')).toHaveValue('UI测试项目');

    await page.getByTestId('input-project-goal').fill('验证UI交互');
    await expect(page.getByTestId('input-project-goal')).toHaveValue('验证UI交互');

    await page.getByTestId('input-project-requirements').fill('测试要求');
    await expect(page.getByTestId('input-project-requirements')).toHaveValue('测试要求');

    await page.getByRole('button', { name: '取消' }).click();
  });

  test('create project button is disabled without required fields', async ({ page }) => {
    await page.getByTestId('btn-create-project').click();
    await page.waitForTimeout(500);

    const submitBtn = page.getByRole('button', { name: '创建项目' });
    await expect(submitBtn).toBeDisabled();

    await page.getByTestId('input-project-name').fill('Test');
    await expect(submitBtn).toBeDisabled();

    await page.getByRole('button', { name: '取消' }).click();
  });

  test('can open and close create agent modal', async ({ page }) => {
    await page.getByTestId('tab-agents').click();
    await page.waitForTimeout(500);

    await page.getByTestId('btn-create-agent').click();
    await page.waitForTimeout(500);

    await expect(page.getByTestId('modal-create-agent')).toBeVisible();
    await expect(page.getByText('选择智能体类型')).toBeVisible();

    await page.mouse.click(10, 10);
    await page.waitForTimeout(500);
    await expect(page.getByTestId('modal-create-agent')).not.toBeVisible();
  });

  test('can select agent type and proceed to config', async ({ page }) => {
    await page.getByTestId('tab-agents').click();
    await page.waitForTimeout(500);
    await page.getByTestId('btn-create-agent').click();
    await page.waitForTimeout(500);

    await page.getByRole('button', { name: '执行者' }).click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: '下一步' }).click();
    await page.waitForTimeout(500);

    await expect(page.getByTestId('input-agent-name')).toBeVisible();
    await expect(page.getByText('本机智能体平台')).toBeVisible();

    await page.mouse.click(10, 10);
  });

  test('status bar shows connection state', async ({ page }) => {
    await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  });

});

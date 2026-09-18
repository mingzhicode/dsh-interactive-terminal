import { chromium, type Page } from 'playwright'

/** Use an isolated browser; callers may select an already installed matching Chromium. */
export function launchBrowser() {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
  return chromium.launch(executablePath ? { executablePath } : {})
}

/** Select the temporary workspace through the official browser directory picker. */
export async function openWorkspace(page: Page, origin: string, workspace: string) {
  await page.goto(origin)
  await page.getByRole('button', { name: '继续', exact: true }).click()
  const later = page.getByRole('button', { name: '稍后配置', exact: true })
  if (await later.isVisible()) await later.click()
  await page.getByRole('button', { name: '添加工作区', exact: true }).click()
  await page.getByRole('button', { name: '编辑路径', exact: true }).click()
  const path = page.getByRole('textbox').last()
  await path.fill(workspace)
  await path.press('Enter')
  await page.getByRole('button', { name: '打开', exact: true }).click()
}

/** Send through the ordinary product composer. */
export async function prompt(page: Page, text: string) {
  const composer = page.locator('[data-composer-card] textarea')
  await composer.fill(text)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
}

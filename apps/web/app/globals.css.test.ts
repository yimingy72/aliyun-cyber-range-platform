import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

function getRuleBlock(css: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{[\\s\\S]*?\\}`, 'm'));

  return match?.[0] ?? '';
}

describe('admin page scroll ownership', () => {
  const stylesheet = fs.readFileSync(path.resolve(__dirname, 'globals.css'), 'utf8');

  it('keeps vertical scrolling on the outer admin content shell', () => {
    const adminMainContent = getRuleBlock(stylesheet, '.admin-main-content');

    expect(adminMainContent).toContain('overflow-y: auto');
    expect(adminMainContent).toContain('scrollbar-width: auto');
  });

  it('does not add a competing scroll container on workbench screens', () => {
    const adminWorkbenchScreen = getRuleBlock(stylesheet, '.admin-workbench-screen');
    const templateWorkbenchScreen = getRuleBlock(stylesheet, '.template-workbench-screen');

    expect(adminWorkbenchScreen).not.toMatch(/overflow-y\s*:/);
    expect(templateWorkbenchScreen).not.toMatch(/overflow-y\s*:/);
  });

  it('constrains the admin main shell so scrolling happens inside the content area', () => {
    const adminMainShell = getRuleBlock(stylesheet, '.admin-main-shell');

    expect(adminMainShell).toContain('min-height: 0');
    expect(adminMainShell).toContain('height: 100%');
    expect(adminMainShell).toContain('overflow: hidden');
  });

  it('anchors single-instance credential tooltips above the row to avoid pagination overlap', () => {
    const credentialTooltip = getRuleBlock(stylesheet, '.single-instance-credential-tooltip');

    expect(credentialTooltip).toContain('bottom: calc(100% + 8px)');
    expect(credentialTooltip).not.toContain('top: calc(100% + 8px)');
  });
});

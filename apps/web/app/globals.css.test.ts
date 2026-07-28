import fs from 'node:fs';
import path from 'node:path';

import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';

function getRuleBlock(css: string, selector: string) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{[\\s\\S]*?\\}`, 'm'));

  return match?.[0] ?? '';
}

function getAtRuleBlock(css: string, atRule: string) {
  const atRuleStart = css.indexOf(atRule);
  const openingBrace = css.indexOf('{', atRuleStart);

  if (atRuleStart === -1 || openingBrace === -1) {
    return '';
  }

  let depth = 0;

  for (let index = openingBrace; index < css.length; index += 1) {
    if (css[index] === '{') {
      depth += 1;
    } else if (css[index] === '}') {
      depth -= 1;

      if (depth === 0) {
        return css.slice(openingBrace + 1, index);
      }
    }
  }

  return '';
}

describe('design system CSS transition contract', () => {
  const stylesheet = fs.readFileSync(path.resolve(__dirname, 'globals.css'), 'utf8');

  it('defines the Tailwind import and core shadcn tokens', () => {
    expect(stylesheet).toContain('@import "tailwindcss";');
    expect(stylesheet).toContain('--background:');
    expect(stylesheet).toContain('--foreground:');
    expect(stylesheet).toContain('--primary:');
    expect(stylesheet).toContain('--radius:');
  });

  it('keeps the shadcn CLI out of production CSS while retaining generated state and orientation variants', async () => {
    expect(stylesheet).not.toContain('shadcn/');

    for (const variant of ['data-open', 'data-closed', 'data-disabled', 'data-active', 'data-horizontal', 'data-vertical']) {
      expect(stylesheet).toContain(`@custom-variant ${variant}`);
    }

    expect(stylesheet).toContain('&:where([data-orientation="horizontal"])');
    expect(stylesheet).toContain('@custom-variant data-vertical (&[data-orientation="vertical"]);');

    const compiler = await compile(
      stylesheet
        .replace('@import "tailwindcss";', '@tailwind utilities;')
        .replace('@import "tw-animate-css";', ''),
    );
    const output = compiler.build(['group-data-horizontal/tabs:flex-col', 'group-data-vertical/tabs:flex-col']);

    expect(output).toContain(
      '.group-data-horizontal\\/tabs\\:flex-col:is(:where(.group\\/tabs):where([data-orientation="horizontal"]) *)',
    );
    expect(output).toContain(
      '.group-data-vertical\\/tabs\\:flex-col:is(:where(.group\\/tabs)[data-orientation="vertical"] *)',
    );
  });

  it('keeps the approved transition token values', () => {
    for (const token of [
      '--background: #eff4fb;',
      '--foreground: #1d2b44;',
      '--card: #ffffff;',
      '--card-foreground: #1d2b44;',
      '--popover: #ffffff;',
      '--popover-foreground: #1d2b44;',
      '--primary: #1f5fbf;',
      '--primary-foreground: #ffffff;',
      '--secondary: #edf3fb;',
      '--secondary-foreground: #21314c;',
      '--muted: #f5f7fb;',
      '--muted-foreground: #617089;',
      '--accent: #e9f1ff;',
      '--accent-foreground: #184b97;',
      '--destructive: #bf3f45;',
      '--border: #d7dfe9;',
      '--input: #d7dfe9;',
      '--ring: #1f5fbf;',
      '--radius: 0.5rem;',
    ]) {
      expect(stylesheet).toContain(token);
    }
  });

  it('maps generated font, sidebar, and chart utilities to light-mode tokens', () => {
    const rootTokens = getRuleBlock(stylesheet, ':root');
    const themeMapping = getRuleBlock(stylesheet, '@theme inline');

    expect(rootTokens).toContain(
      '--platform-font-sans: "IBM Plex Sans", "PingFang SC", "Helvetica Neue", sans-serif;',
    );
    expect(themeMapping).toContain('--font-sans: var(--platform-font-sans);');
    expect(themeMapping).toContain('--font-heading: var(--platform-font-sans);');
    expect(themeMapping).not.toContain('--font-sans: var(--font-sans);');

    for (const token of [
      '--sidebar:',
      '--sidebar-foreground:',
      '--sidebar-primary:',
      '--sidebar-primary-foreground:',
      '--sidebar-accent:',
      '--sidebar-accent-foreground:',
      '--sidebar-border:',
      '--sidebar-ring:',
      '--chart-1:',
      '--chart-2:',
      '--chart-3:',
      '--chart-4:',
      '--chart-5:',
    ]) {
      expect(rootTokens).toContain(token);
    }
  });
});

describe('admin page scroll ownership', () => {
  const stylesheet = fs.readFileSync(path.resolve(__dirname, 'globals.css'), 'utf8');

  it('defines one compact surface and responsive inset for admin list workbenches', () => {
    const surface = getRuleBlock(stylesheet, '.admin-workbench-surface');
    const narrowScreenRules = getAtRuleBlock(stylesheet, '@media (max-width: 640px)');

    expect(surface).toContain('border-radius: 6px');
    expect(surface).toContain('background: var(--card)');
    expect(surface).toContain('padding: 16px');
    expect(getRuleBlock(narrowScreenRules, '.admin-workbench-surface')).toContain('padding: 12px');
  });

  it('keeps the workspace inset while hiding the sidebar below the desktop breakpoint', () => {
    const narrowScreenRules = getAtRuleBlock(stylesheet, '@media (max-width: 1023px)');

    expect(getRuleBlock(narrowScreenRules, '.admin-workspace')).toContain('padding: 14px');
    expect(getRuleBlock(narrowScreenRules, '.admin-sidebar')).toContain('display: none');
  });

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

  it('allows admin list sections to contain wide tables within their own scroll frames', () => {
    const adminSection = getRuleBlock(stylesheet, '.admin-screen > section');
    const adminWorkbenchPanel = getRuleBlock(stylesheet, '.admin-workbench-panel');

    expect(adminSection).toContain('min-width: 0');
    expect(adminWorkbenchPanel).toContain('grid-template-columns: minmax(0, 1fr)');
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

  it('uses the light-blue platform treatment for single-instance credential tooltips', () => {
    const credentialTooltip = getRuleBlock(stylesheet, '.single-instance-credential-tooltip');

    expect(credentialTooltip).toContain('background: #edf5ff');
    expect(credentialTooltip).toContain('border: 1px solid #c7ddf7');
    expect(credentialTooltip).not.toContain('background: #1f2f49');
  });
});

import { promisify } from 'node:util';
import { execFile, type ExecFileOptions } from 'node:child_process';

export type OpenTofuCommandResult = {
  stdout: string;
  stderr: string;
};

export type OpenTofuExecutor = (
  command: string,
  args: string[],
  options: ExecFileOptions,
) => Promise<OpenTofuCommandResult>;

export type OpenTofuRunnerOptions = {
  binaryPath?: string;
  executor?: OpenTofuExecutor;
  commandTimeoutMs?: number;
  parallelism?: number;
};

export type OpenTofuWorkspaceCommandOptions = {
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

export type OpenTofuValidateOptions = OpenTofuWorkspaceCommandOptions & {
  varsFilePath?: string;
};

export type OpenTofuPlanOptions = OpenTofuWorkspaceCommandOptions & {
  planFilePath: string;
  varsFilePath?: string;
  targets?: string[];
  destroy?: boolean;
};

export type OpenTofuShowPlanOptions = OpenTofuWorkspaceCommandOptions & { planFilePath: string };
export type OpenTofuImportOptions = OpenTofuWorkspaceCommandOptions & {
  address: string;
  resourceId: string;
  varsFilePath?: string;
};

export type OpenTofuApplyOptions = OpenTofuWorkspaceCommandOptions & {
  planFilePath: string;
};

export type OpenTofuDestroyOptions = OpenTofuWorkspaceCommandOptions & {
  varsFilePath?: string;
  targets?: string[];
};

const execFileAsync = promisify(execFile);
const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_PARALLELISM = 10;

function commandAborted() {
  return Object.assign(new Error('OpenTofu command aborted'), { name: 'AbortError' });
}

async function defaultExecutor(
  command: string,
  args: string[],
  options: ExecFileOptions,
): Promise<OpenTofuCommandResult> {
  const { timeout = DEFAULT_COMMAND_TIMEOUT_MS, signal, ...executionOptions } = options;
  if (signal?.aborted) throw commandAborted();
  const execution = execFileAsync(command, args, {
    ...executionOptions,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  let interrupted = false;
  let aborted = false;
  // execFile's built-in timeout closes stdio before killing, which can abort OpenTofu state persistence.
  const timer = setTimeout(() => {
    if (!aborted) interrupted = execution.child.kill('SIGTERM');
  }, timeout);
  timer.unref();
  const onAbort = () => {
    if (aborted) return;
    aborted = true;
    clearTimeout(timer);
    if (!interrupted) execution.child.kill('SIGTERM');
  };
  // Node's execFile signal also closes stdio; terminate manually and await state persistence.
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();

  try {
    const result = await execution;
    if (aborted) throw Object.assign(commandAborted(), result);
    if (interrupted) {
      throw Object.assign(new Error(`OpenTofu command timed out after ${timeout} ms`), result);
    }
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    if (aborted) throw Object.assign(commandAborted(), {
      stdout: (error as OpenTofuCommandResult)?.stdout ?? '',
      stderr: (error as OpenTofuCommandResult)?.stderr ?? '',
    });
    if (interrupted && error instanceof Error) {
      error.message = `OpenTofu command timed out after ${timeout} ms`;
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export class OpenTofuRunner {
  private readonly binaryPath: string;
  private readonly executor: OpenTofuExecutor;
  private readonly commandTimeoutMs: number;
  private readonly parallelism: number;

  constructor(options: OpenTofuRunnerOptions = {}) {
    this.binaryPath = options.binaryPath ?? 'tofu';
    this.executor = options.executor ?? defaultExecutor;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const configuredParallelism = process.env.OPENTOFU_PARALLELISM?.trim();
    this.parallelism = options.parallelism ?? (configuredParallelism ? Number(configuredParallelism) : DEFAULT_PARALLELISM);
    if (!Number.isFinite(this.commandTimeoutMs) || this.commandTimeoutMs <= 0 || this.commandTimeoutMs > 2_147_483_647) {
      throw new Error('OpenTofu command timeout must be a positive number no greater than 2147483647 ms');
    }
    if (!Number.isSafeInteger(this.parallelism) || this.parallelism < 1 || this.parallelism > 32) {
      throw new Error('OpenTofu parallelism must be an integer from 1 to 32');
    }
  }

  async init(options: OpenTofuWorkspaceCommandOptions): Promise<OpenTofuCommandResult> {
    return this.run(['init', '-input=false', '-no-color'], options);
  }

  async validate(options: OpenTofuValidateOptions): Promise<OpenTofuCommandResult> {
    const args = ['validate', '-no-color'];

    if (options.varsFilePath) {
      args.push('-var-file', options.varsFilePath);
    }

    return this.run(args, options);
  }

  async plan(options: OpenTofuPlanOptions): Promise<OpenTofuCommandResult> {
    const args = ['plan', '-input=false', '-no-color', `-parallelism=${this.parallelism}`, '-out', options.planFilePath];
    if (options.destroy) args.push('-destroy');
    args.push(...targetArguments(options.targets));

    if (options.varsFilePath) {
      args.push('-var-file', options.varsFilePath);
    }

    return this.run(args, options);
  }

  async apply(options: OpenTofuApplyOptions): Promise<OpenTofuCommandResult> {
    return this.run(['apply', '-input=false', '-no-color', '-auto-approve', `-parallelism=${this.parallelism}`, options.planFilePath], options);
  }

  async output<T>(options: OpenTofuWorkspaceCommandOptions): Promise<T> {
    const result = await this.run(['output', '-json'], options);

    return JSON.parse(result.stdout) as T;
  }

  async showPlan<T = unknown>(options: OpenTofuShowPlanOptions): Promise<T> {
    const result = await this.run(['show', '-json', options.planFilePath], options);
    return JSON.parse(result.stdout) as T;
  }

  showPlanJson<T = unknown>(options: OpenTofuShowPlanOptions): Promise<T> {
    return this.showPlan<T>(options);
  }

  async importResource(options: OpenTofuImportOptions): Promise<OpenTofuCommandResult> {
    if (!options.address.trim() || options.address.trim().startsWith('-') || !options.resourceId.trim() || options.resourceId.trim().startsWith('-')) {
      throw new Error('OpenTofu import requires an exact resource address and resource ID');
    }
    const args = ['import', '-input=false', '-no-color'];
    if (options.varsFilePath) args.push('-var-file', options.varsFilePath);
    args.push(options.address, options.resourceId);
    return this.run(args, options);
  }

  async destroy(options: OpenTofuDestroyOptions): Promise<OpenTofuCommandResult> {
    const args = ['destroy', '-input=false', '-no-color', '-auto-approve', `-parallelism=${this.parallelism}`];
    args.push(...targetArguments(options.targets));

    if (options.varsFilePath) {
      args.push('-var-file', options.varsFilePath);
    }

    return this.run(args, options);
  }

  private async run(
    args: string[],
    options: OpenTofuWorkspaceCommandOptions,
  ): Promise<OpenTofuCommandResult> {
    if (options.signal?.aborted) throw commandAborted();
    return this.executor(this.binaryPath, args, {
      cwd: options.workspaceDir,
      env: options.env,
      timeout: this.commandTimeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  }
}

function targetArguments(targets: string[] = []) {
  if (targets.some(target => !target.trim())) throw new Error('OpenTofu target address must not be empty');
  return targets.map(target => `-target=${target}`);
}

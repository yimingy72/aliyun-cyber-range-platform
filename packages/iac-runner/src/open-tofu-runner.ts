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
};

export type OpenTofuWorkspaceCommandOptions = {
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
};

export type OpenTofuValidateOptions = OpenTofuWorkspaceCommandOptions & {
  varsFilePath?: string;
};

export type OpenTofuPlanOptions = OpenTofuWorkspaceCommandOptions & {
  planFilePath: string;
  varsFilePath?: string;
};

export type OpenTofuApplyOptions = OpenTofuWorkspaceCommandOptions & {
  planFilePath: string;
};

export type OpenTofuDestroyOptions = OpenTofuWorkspaceCommandOptions & {
  varsFilePath?: string;
};

const execFileAsync = promisify(execFile);

async function defaultExecutor(
  command: string,
  args: string[],
  options: ExecFileOptions,
): Promise<OpenTofuCommandResult> {
  const result = await execFileAsync(command, args, {
    ...options,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export class OpenTofuRunner {
  private readonly binaryPath: string;
  private readonly executor: OpenTofuExecutor;

  constructor(options: OpenTofuRunnerOptions = {}) {
    this.binaryPath = options.binaryPath ?? 'tofu';
    this.executor = options.executor ?? defaultExecutor;
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
    const args = ['plan', '-input=false', '-no-color', '-out', options.planFilePath];

    if (options.varsFilePath) {
      args.push('-var-file', options.varsFilePath);
    }

    return this.run(args, options);
  }

  async apply(options: OpenTofuApplyOptions): Promise<OpenTofuCommandResult> {
    return this.run(['apply', '-input=false', '-no-color', '-auto-approve', options.planFilePath], options);
  }

  async output<T>(options: OpenTofuWorkspaceCommandOptions): Promise<T> {
    const result = await this.run(['output', '-json'], options);

    return JSON.parse(result.stdout) as T;
  }

  async destroy(options: OpenTofuDestroyOptions): Promise<OpenTofuCommandResult> {
    const args = ['destroy', '-input=false', '-no-color', '-auto-approve'];

    if (options.varsFilePath) {
      args.push('-var-file', options.varsFilePath);
    }

    return this.run(args, options);
  }

  private async run(
    args: string[],
    options: OpenTofuWorkspaceCommandOptions,
  ): Promise<OpenTofuCommandResult> {
    return this.executor(this.binaryPath, args, {
      cwd: options.workspaceDir,
      env: options.env,
    });
  }
}

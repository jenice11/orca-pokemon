import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { callCli } from './cli.ts';

test('CLI adapter parses envelopes and passes arguments without a shell', async (): Promise<void> => {
  const previous: string | undefined = process.env.ORCA_CLI_COMMAND;
  process.env.ORCA_CLI_COMMAND = process.execPath;
  try {
    const result: unknown = await callCli(['-e', 'process.stdout.write(JSON.stringify({ok:true,result:process.argv.slice(1)}))', '--', 'literal; $(never-execute)']);
    assert.deepEqual(result, ['literal; $(never-execute)', '--environment', 'local', '--json']);
    if (process.platform === 'win32') {
      const previousUserDataPath: string | undefined = process.env.ORCA_USER_DATA_PATH;
      const previousAppData: string | undefined = process.env.APPDATA;
      delete process.env.ORCA_USER_DATA_PATH;
      delete process.env.APPDATA;
      try {
        const userDataPath: unknown = await callCli(['-e', 'process.stdout.write(JSON.stringify({ok:true,result:process.env.ORCA_USER_DATA_PATH}))', '--']);
        assert.equal(userDataPath, resolve(homedir(), 'AppData', 'Roaming', 'orca'));
      } finally {
        if (previousUserDataPath === undefined) delete process.env.ORCA_USER_DATA_PATH;
        else process.env.ORCA_USER_DATA_PATH = previousUserDataPath;
        if (previousAppData === undefined) delete process.env.APPDATA;
        else process.env.APPDATA = previousAppData;
      }
    }
    await assert.rejects(callCli(['-e', 'console.log(JSON.stringify({ok:false,error:{code:"unavailable",message:"private preview"}}))', '--']), /unavailable/);
    await assert.rejects(callCli(['-e', 'console.log("invalid")', '--']), /invalid JSON/);
    await assert.rejects(callCli(['-e', 'process.exit(1)', '--']), /failed/);
    await assert.rejects(callCli(['-e', 'process.stderr.write("command detail");process.exit(1)', '--']), /command detail/);
    process.env.ORCA_CLI_COMMAND = '/nonexistent-pokemon-orca-test';
    await assert.rejects(callCli([]), /ENOENT/);
  } finally {
    if (previous === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = previous;
  }
});

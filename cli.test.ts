import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callCli } from './cli.ts';

test('CLI adapter parses envelopes and passes arguments without a shell', async (): Promise<void> => {
  const previous: string | undefined = process.env.ORCA_CLI_COMMAND;
  process.env.ORCA_CLI_COMMAND = process.execPath;
  try {
    const result: unknown = await callCli(['-e', 'process.stdout.write(JSON.stringify({ok:true,result:process.argv.slice(1)}))', '--', 'literal; $(never-execute)']);
    assert.deepEqual(result, ['literal; $(never-execute)', '--json']);
    await assert.rejects(callCli(['-e', 'console.log(JSON.stringify({ok:false,error:{code:"unavailable",message:"private preview"}}))', '--']), /unavailable/);
    await assert.rejects(callCli(['-e', 'console.log("invalid")', '--']), /invalid JSON/);
    await assert.rejects(callCli(['-e', 'process.exit(1)', '--']), /failed/);
    process.env.ORCA_CLI_COMMAND = '/nonexistent-pokemon-orca-test';
    await assert.rejects(callCli([]), /ENOENT/);
  } finally {
    if (previous === undefined) delete process.env.ORCA_CLI_COMMAND;
    else process.env.ORCA_CLI_COMMAND = previous;
  }
});

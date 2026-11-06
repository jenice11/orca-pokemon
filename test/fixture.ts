export function fixture(): unknown {
  return {
    worktrees: [{ worktreeId: 'project::/project', displayName: 'Project', agents: [
      { paneKey: 'tab:pane', conversationName: '<script>hostile</script>', agentType: 'codex', state: 'working', hasLivePty: true },
      { paneKey: 'tab:old', state: 'done', hasLivePty: false },
      { paneKey: 'tab:unknown', state: 'done' }
    ] }],
    hostScope: { hostIds: ['local'], omittedHostIds: [] }, truncated: false
  };
}

# Agent Execution Modes: Hybrid Architecture

## Overview

Workbench supports two execution modes for agents, each optimized for different task types:

1. **Pooled Mode** (`exec: null`) - API-based, no file access
2. **Exec Mode** (`exec: "command"`) - File system access via worktrees

## Current Hybrid Configuration

### Exec Mode Agents (File Writers)
These agents get dedicated worktrees and can directly modify code:

- **builder** - Implements features, fixes bugs, writes code files
- **doc-writer** - Creates/updates documentation files
- **test-writer** - Writes test files
- **refactorer** - Modifies code structure

**Command**: `claude code --non-interactive --dangerously-skip-permissions '{prompt}'`

**Workflow**:
1. Agent claims task
2. System creates git worktree from main branch
3. Agent runs in worktree with full file access
4. Agent reads code, makes changes, commits
5. System automatically opens PR for review
6. Worktree cleaned up after completion

### Pooled Mode Agents (Analyzers)
These agents analyze and provide feedback without file modifications:

- **reviewer** - Reviews PRs, provides feedback in comments
- **analyst** - Research, data analysis, planning

**Workflow**:
1. Agent claims task
2. Agent analyzes using LLM API (faster, cheaper)
3. Agent returns analysis as text
4. Output saved to task comments

## When to Use Each Mode

### Use Exec Mode When:
- ✅ Task requires creating/modifying files
- ✅ Task needs to read codebase context
- ✅ Task should result in a PR
- ✅ Task involves running tests/builds
- ✅ Task needs git operations (commit, branch, etc.)

**Examples**:
- "Add user authentication endpoint"
- "Write tests for payment module"
- "Refactor database layer"
- "Update API documentation"

### Use Pooled Mode When:
- ✅ Task is analysis/research only
- ✅ Task needs quick response (no worktree overhead)
- ✅ Task output is text/recommendations
- ✅ Task doesn't require code changes
- ✅ Cost optimization is priority (pooled is cheaper)

**Examples**:
- "Review this PR for security issues"
- "Analyze competitor pricing models"
- "Research best practices for X"
- "Provide feedback on architecture design"

## Long-Term Architecture Principles

### 1. Task Classification
Automatically determine execution mode based on task metadata:

```javascript
// Future enhancement: auto-detect exec mode needed
function inferExecMode(task) {
  // File modification keywords → exec mode
  if (task.title.match(/^(add|create|write|implement|refactor|fix)/i)) {
    return 'exec';
  }

  // Analysis keywords → pooled mode
  if (task.title.match(/^(review|analyze|research|plan)/i)) {
    return 'pooled';
  }

  // Default based on labels
  const execLabels = ['feature', 'bug', 'tests', 'docs', 'refactor'];
  const pooledLabels = ['review', 'analysis', 'research', 'planning'];

  if (task.labels?.some(l => execLabels.includes(l))) return 'exec';
  if (task.labels?.some(l => pooledLabels.includes(l))) return 'pooled';

  return 'pooled'; // default to cheaper mode
}
```

### 2. Multi-Stage Workflows
Complex tasks can flow through both modes:

```
Research (pooled) → Plan (pooled) → Implement (exec) → Review (pooled) → Deploy
```

**Example**:
1. `analyst` (pooled) researches approaches → creates task breakdown
2. `builder` (exec) implements each task → opens PRs
3. `reviewer` (pooled) checks PRs → provides feedback
4. `builder` (exec) addresses feedback → updates PRs

### 3. Cost Optimization Strategies

**Tiered Execution**:
- **Tier 1**: Pooled mode with free models (groq, cerebras) - $0/month
- **Tier 2**: Exec mode with free models - minimal cost (just API calls)
- **Tier 3**: Exec mode with premium models - for critical tasks only

**Budget Guards**:
```json
{
  "agents": {
    "builder-premium": {
      "model": "anthropic/claude-sonnet-4",
      "exec": "claude code ...",
      "filters": {
        "priority_min": 9,  // Only critical tasks
        "labels": ["security", "critical"]
      },
      "max_daily_cost": 5.00  // Future: cost limits
    }
  }
}
```

### 4. Agent Specialization Matrix

| Agent Type | Exec Mode | Model Tier | Use Case | Cost/Task |
|------------|-----------|------------|----------|-----------|
| analyst | Pooled | Free | Research, planning | $0 |
| reviewer | Pooled | Free/Fast | PR reviews, feedback | $0 |
| builder | Exec | Free/Smart | Feature implementation | $0.01-0.05 |
| doc-writer | Exec | Free | Documentation | $0.01 |
| test-writer | Exec | Free | Test generation | $0.01-0.02 |
| refactorer | Exec | Free/Smart | Code cleanup | $0.02-0.05 |
| critical-builder | Exec | Premium | P1 bugs, security | $0.50-2.00 |

### 5. Worktree Management Best Practices

**Exec Mode Considerations**:
- Each exec-mode task gets isolated worktree (prevents conflicts)
- Worktrees are cleaned up automatically (even on failure)
- PRs link back to task for traceability
- Agent output preserved in `last-run.json` in worktree

**Resource Limits**:
```javascript
// Future enhancements
const EXEC_MODE_LIMITS = {
  maxConcurrentWorktrees: 10,    // Prevent disk space issues
  maxWorktreeAgeMinutes: 120,    // Cleanup stale worktrees
  maxFilesChanged: 50,           // Flag for review if too many changes
  maxLinesChanged: 2000,         // Flag for breaking into smaller tasks
};
```

### 6. Hybrid Workflow Patterns

#### Pattern A: Research → Implement
```javascript
// analyst (pooled) creates breakdown
Task: "Add OAuth authentication"
→ analyst output: "Need 3 subtasks: (1) OAuth routes, (2) token storage, (3) middleware"

// System auto-creates subtasks with labels
→ t_001: "Implement OAuth routes" [feature, backend]
→ t_002: "Add token storage" [feature, backend]
→ t_003: "Create auth middleware" [feature, backend]

// builder (exec) implements each
→ builder claims t_001, writes code, opens PR
→ builder claims t_002, writes code, opens PR
→ builder claims t_003, writes code, opens PR
```

#### Pattern B: Implement → Review → Fix
```javascript
// builder (exec) implements
builder: opens PR #123

// Task moves to review column
→ reviewer (pooled) analyzes PR
→ reviewer: "Security issue: validate input on line 45"

// Task moves back to doing
→ builder (exec) fixes issue
→ builder: updates PR #123
```

## Migration Path

### Phase 1: Current (Immediate)
- ✅ Builder, doc-writer, test-writer, refactorer in exec mode
- ✅ Reviewer, analyst in pooled mode
- Manual task label assignment determines which agent picks up work

### Phase 2: Smart Routing (Next 2 weeks)
- Auto-detect exec mode needed based on task title/description
- Add `exec_mode` field to tasks table
- UI indicator for exec vs pooled tasks
- Cost tracking per execution mode

### Phase 3: Multi-Stage Workflows (Next month)
- Task dependencies with mode transitions
- Auto-task-breakdown: analyst creates implementation tasks
- Workflow templates: "research → plan → implement → review → deploy"

### Phase 4: Optimization (Ongoing)
- Cost/performance metrics per agent
- A/B testing: pooled vs exec for same task type
- Model selection based on task complexity
- Automatic retries with mode escalation (pooled fails → retry with exec)

## Troubleshooting

### Exec Mode Agent Not Creating Files
**Problem**: Agent marks task complete but no files changed

**Diagnosis**:
1. Check agent output in task comments
2. Look for "no commits" in PR creation logs
3. Check worktree was actually created

**Solutions**:
- Verify `claude code` CLI is available: `which claude`
- Check system prompt emphasizes writing files, not describing them
- Ensure task has clear acceptance criteria

### Pooled Mode Agent Trying to Write Files
**Problem**: Agent generates code in comments instead of analysis

**Solution**: Update system prompt to clarify:
```json
{
  "system_prompt": "You are a code reviewer. Provide feedback in your response text. Do NOT write code - only analyze and comment on existing code."
}
```

### High Costs from Exec Mode
**Problem**: Exec mode agents generating high API costs

**Solutions**:
1. Use free models: `"model": "free:smart"`
2. Add cost limits (future feature)
3. Move more agents to pooled mode
4. Use pooled for research, exec only for final implementation

## Future Enhancements

### Adaptive Execution
```javascript
// Agent starts in pooled mode, escalates to exec if needed
if (agent.pooledResponse.includes("I need to see the code")) {
  // Retry same task with exec mode
  retryWithExec(task);
}
```

### Hybrid Tasks
```javascript
// Single task uses both modes
{
  "title": "Implement feature X",
  "stages": [
    { "mode": "pooled", "agent": "analyst", "action": "research" },
    { "mode": "exec", "agent": "builder", "action": "implement" },
    { "mode": "pooled", "agent": "reviewer", "action": "review" }
  ]
}
```

### Smart Model Selection
```javascript
// Automatically choose model based on task complexity
function selectModel(task, executionMode) {
  if (executionMode === 'pooled') {
    return 'free:fast'; // Cheap for analysis
  }

  // Exec mode: consider task complexity
  const complexity = estimateComplexity(task);
  if (complexity > 8) return 'anthropic/claude-sonnet-4';
  if (complexity > 5) return 'free:smart';
  return 'free:fast';
}
```

## Summary

The hybrid architecture balances:
- **Speed**: Pooled mode is faster (no worktree setup)
- **Cost**: Pooled mode is cheaper (fewer tokens, free models)
- **Capability**: Exec mode can actually write code
- **Safety**: Exec mode isolated in worktrees, reviewed via PRs

**Rule of thumb**: Use pooled mode by default, exec mode when you need files written.

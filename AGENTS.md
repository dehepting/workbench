# Multi-Agent System

Workbench supports running multiple specialized agents simultaneously, each with different roles, models, and task filters.

## Quick Start

```bash
# Start all configured agents
npm run agents

# Or start server + agents together
npm start & npm run agents
```

## Configuration

Create `agents.json` in the project root:

```json
{
  "agents": {
    "builder": {
      "description": "Handles feature implementation and bug fixes",
      "model": "free:smart",
      "filters": {
        "labels": ["feature", "bug"]
      }
    },
    "reviewer": {
      "description": "Reviews code in the review column",
      "model": "free:fast",
      "filters": {
        "column": "review"
      }
    },
    "doc-writer": {
      "description": "Writes and updates documentation",
      "model": "google/gemini-2.5-flash",
      "filters": {
        "labels": ["docs"]
      }
    }
  }
}
```

## Agent Configuration

Each agent supports:

### Basic Settings
- **`description`** - Human-readable description
- **`model`** - Model to use (`free:smart`, `groq/llama-3.3-70b`, `anthropic/claude-sonnet-4`, etc.)
- **`exec`** - Exec mode command (e.g., `claude -p {prompt}`) or `null` for pooled mode
- **`enabled`** - Whether this agent is active (default: `true`)

### Task Filters
- **`column`** - Only pick tasks in this column (`backlog`, `todo`, `doing`, `review`)
- **`labels`** - Only pick tasks with ANY of these labels (array)
- **`exclude_labels`** - Skip tasks with ANY of these labels (array)
- **`priority_min`** - Only pick tasks with priority >= this value
- **`priority_max`** - Only pick tasks with priority <= this value
- **`project_id`** - Only pick tasks from this project

### Behavior
- **`system_prompt`** - Custom system prompt for this agent's role
- **`max_retries`** - Maximum retries for failed tasks (default: 3)
- **`lease_minutes`** - How long to hold task leases (default: 30)
- **`poll_ms`** - Polling interval in milliseconds (default: 4000)

## Example Configurations

### Cost-Optimized Squad

```json
{
  "agents": {
    "fast-reviewer": {
      "description": "Quick code reviews",
      "model": "groq/llama-3.3-70b",
      "filters": { "column": "review" },
      "system_prompt": "You are a code reviewer. Check for bugs, security issues, and code quality. Be concise."
    },
    "doc-writer": {
      "description": "Documentation updates",
      "model": "google/gemini-2.5-flash",
      "filters": { "labels": ["docs"] },
      "system_prompt": "You are a technical writer. Create clear, concise documentation."
    },
    "test-generator": {
      "description": "Generates tests",
      "model": "free:smart",
      "filters": { "labels": ["tests"] },
      "system_prompt": "You are a test engineer. Write comprehensive tests covering edge cases."
    }
  }
}
```

### Priority-Based Routing

```json
{
  "agents": {
    "critical-handler": {
      "description": "Handles P0/P1 critical issues",
      "model": "anthropic/claude-sonnet-4",
      "filters": { "priority_min": 9 }
    },
    "regular-worker": {
      "description": "Handles normal priority work",
      "model": "free:smart",
      "filters": {
        "priority_min": 3,
        "priority_max": 8
      }
    },
    "bulk-worker": {
      "description": "Handles low-priority bulk work",
      "model": "free:fast",
      "filters": { "priority_max": 2 }
    }
  }
}
```

### Exec Mode with Claude Code

```json
{
  "agents": {
    "claude-coder": {
      "description": "Uses Claude Code for complex features",
      "exec": "claude -p {prompt}",
      "filters": {
        "labels": ["feature", "complex"],
        "exclude_labels": ["simple"]
      }
    },
    "simple-pooled": {
      "description": "Uses free LLMs for simple tasks",
      "model": "free:smart",
      "filters": {
        "labels": ["simple", "docs", "tests"]
      }
    }
  }
}
```

## Model Aliases

Workbench has intelligent model routing built-in:

- **`free:smart`** - Best free model (tier A providers: Groq, Cerebras, Google, Nvidia)
- **`free:fast`** - Fastest free model
- **`free:cheap`** - Cheapest model (may include paid tier B/C)

Or specify exact provider/model:
- `groq/llama-3.3-70b`
- `google/gemini-2.5-flash`
- `anthropic/claude-sonnet-4`
- `deepseek/deepseek-r1`

## Provider Tiers

**Tier A (Free):**
- Groq, Cerebras, Google, Nvidia, Mistral

**Tier B (Cheap: $0.03-1.2/M tokens):**
- OpenRouter, ZAI, DashScope, DeepInfra, SambaNova

**Tier C (Paid: $0.9+/M tokens):**
- Together, Fireworks, SiliconFlow, Hyperbolic, Perplexity

## How It Works

1. **Start orchestrator**: `npm run agents` reads `agents.json`
2. **Spawn workers**: Each agent runs as a separate worker process
3. **Task routing**: Agents poll for tasks matching their filters
4. **Parallel execution**: Multiple tasks execute simultaneously
5. **Automatic retry**: Failed tasks retry per agent config
6. **Cost tracking**: All runs logged to cost ledger

## Filter Logic

Agents pick tasks that match **ALL** filter criteria:

```javascript
// This agent picks tasks that are:
{
  "filters": {
    "column": "review",           // AND in review column
    "labels": ["urgent", "bug"],  // AND has "urgent" OR "bug" label
    "exclude_labels": ["wip"],    // AND does NOT have "wip" label
    "priority_min": 5              // AND priority >= 5
  }
}
```

## Monitoring

View agent status:
```bash
# Check running agents
GET /api/agents

# Check specific agent
GET /api/agents/:id

# View cost by agent
GET /api/ledger
```

## Best Practices

1. **Start small**: Begin with 2-3 agents, add more as needed
2. **Use free models**: Tier A providers (Groq, Google) are free and excellent
3. **Specialize agents**: Different roles with different system prompts
4. **Filter wisely**: Prevent agents from competing for same tasks
5. **Monitor costs**: Check `/api/ledger` to track spend per agent

## Scaling to 10-100 Agents

**Example: 50 agents for <$50/month**

- 30 agents on free tier (Groq, Google) = $0
- 15 agents on cheap models (DeepSeek R1) = $20-30/month
- 5 agents on premium models (Claude) for critical work = $20-30/month

**Total: ~$40-60/month for 50 simultaneous agents**

## Troubleshooting

**Issue: Agents not picking up tasks**
- Check filters match task properties
- Verify tasks are in correct column
- Check agent is enabled: `"enabled": true`

**Issue: High costs**
- Review which models each agent uses
- Switch expensive agents to free tier
- Add priority filters to route work efficiently

**Issue: Agents competing for tasks**
- Use mutually exclusive filters
- Set different `column` per agent
- Use `labels` + `exclude_labels` to partition work

## Next Steps

- [Goal → Task Breakdown](https://github.com/dehepting/workbench/issues/4) - Auto-generate tasks from high-level goals
- [Continuous Agents](https://github.com/dehepting/workbench/issues/5) - Background monitoring and proactive maintenance

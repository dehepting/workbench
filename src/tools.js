// File operation tools for LLM agents
// Provides read_file, write_file, edit_file, list_files capabilities

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { execSync } from 'node:child_process';

/**
 * Tool definitions in OpenAI/Anthropic function calling format
 */
export const FILE_TOOLS = [
  {
    name: 'read_file',
    description: 'Read the contents of a file. Returns the file content as a string.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to read (relative to working directory)'
        }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Creates the file if it doesn\'t exist, overwrites if it does.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to write (relative to working directory)'
        },
        content: {
          type: 'string',
          description: 'Content to write to the file'
        }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'edit_file',
    description: 'Edit a file by replacing old text with new text. The old text must match exactly.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Path to the file to edit'
        },
        old_text: {
          type: 'string',
          description: 'Exact text to find and replace (must match exactly including whitespace)'
        },
        new_text: {
          type: 'string',
          description: 'New text to replace the old text with'
        }
      },
      required: ['path', 'old_text', 'new_text']
    }
  },
  {
    name: 'list_files',
    description: 'List files in a directory with optional glob pattern filtering.',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to list (relative to working directory, default: ".")'
        },
        pattern: {
          type: 'string',
          description: 'Optional glob pattern to filter files (e.g., "*.js", "src/**/*.ts")'
        }
      },
      required: []
    }
  },
  {
    name: 'run_command',
    description: 'Run a shell command and return its output. Use for git operations, running tests, etc.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command to execute'
        }
      },
      required: ['command']
    }
  }
];

/**
 * Execute a tool call in the given working directory
 */
export function executeTool(toolName, args, { cwd = process.cwd() } = {}) {
  const absPath = (p) => resolve(cwd, p || '.');

  switch (toolName) {
    case 'read_file': {
      const filePath = absPath(args.path);
      try {
        const content = readFileSync(filePath, 'utf8');
        return { success: true, content };
      } catch (err) {
        return { success: false, error: `Failed to read file: ${err.message}` };
      }
    }

    case 'write_file': {
      const filePath = absPath(args.path);
      try {
        writeFileSync(filePath, args.content, 'utf8');
        return { success: true, message: `Wrote ${args.content.length} bytes to ${args.path}` };
      } catch (err) {
        return { success: false, error: `Failed to write file: ${err.message}` };
      }
    }

    case 'edit_file': {
      const filePath = absPath(args.path);
      try {
        const content = readFileSync(filePath, 'utf8');
        if (!content.includes(args.old_text)) {
          return {
            success: false,
            error: `Old text not found in file. Make sure it matches exactly including whitespace.`
          };
        }
        const newContent = content.replace(args.old_text, args.new_text);
        writeFileSync(filePath, newContent, 'utf8');
        return { success: true, message: `Edited ${args.path}` };
      } catch (err) {
        return { success: false, error: `Failed to edit file: ${err.message}` };
      }
    }

    case 'list_files': {
      const dirPath = absPath(args.path || '.');
      try {
        let files = readdirSync(dirPath);

        // Filter by pattern if provided (simple glob matching)
        if (args.pattern) {
          const regex = new RegExp(
            '^' + args.pattern
              .replace(/\./g, '\\.')
              .replace(/\*/g, '.*')
              .replace(/\?/g, '.') + '$'
          );
          files = files.filter(f => regex.test(f));
        }

        // Add file/directory indicator
        const entries = files.map(f => {
          const fullPath = join(dirPath, f);
          const isDir = statSync(fullPath).isDirectory();
          return isDir ? `${f}/` : f;
        });

        return { success: true, files: entries };
      } catch (err) {
        return { success: false, error: `Failed to list files: ${err.message}` };
      }
    }

    case 'run_command': {
      try {
        const output = execSync(args.command, {
          cwd,
          encoding: 'utf8',
          maxBuffer: 10 * 1024 * 1024 // 10MB
        });
        return { success: true, output: output.trim() };
      } catch (err) {
        return {
          success: false,
          error: `Command failed: ${err.message}`,
          output: err.stdout?.toString() || ''
        };
      }
    }

    default:
      return { success: false, error: `Unknown tool: ${toolName}` };
  }
}

/**
 * Format tool result for inclusion in chat messages
 */
export function formatToolResult(result) {
  if (result.success) {
    if (result.content !== undefined) return result.content;
    if (result.output !== undefined) return result.output;
    if (result.files !== undefined) return result.files.join('\n');
    return result.message || 'Success';
  } else {
    return `Error: ${result.error}`;
  }
}

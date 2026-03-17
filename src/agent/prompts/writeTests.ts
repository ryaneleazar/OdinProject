export function writeTestsPrompt(params: {
  title: string;
  description: string;
  changedFiles: string[];
}) {
  return `You are an autonomous developer writing tests for a recently implemented ticket.

## Ticket
**Title:** ${params.title}
**Description:** ${params.description}

## Changed Files
${params.changedFiles.map((f) => `- ${f}`).join("\n")}

## Instructions
1. Read the changed files to understand what was implemented.
2. Write unit tests covering the new/changed functionality.
3. Follow the existing test patterns in the project (look for existing test files).
4. Focus on meaningful test cases — happy paths, edge cases, and error cases.
5. Do NOT commit — just write the test files.

## Guidelines
- Use the project's existing test framework
- Place test files next to source files or in the test directory, following existing patterns
- If you can't determine the test framework, use Vitest
- Keep tests focused and readable`;
}

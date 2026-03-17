export function implementTicketPrompt(params: {
  title: string;
  description: string;
  repoContext?: string;
}) {
  return `You are an autonomous developer implementing a ticket.

## Ticket
**Title:** ${params.title}
**Description:** ${params.description}

${params.repoContext ? `## Repository Context\n${params.repoContext}` : ""}

## Instructions
1. First, explore the codebase to understand the project structure, conventions, and relevant files.
2. Read existing code carefully before making changes.
3. Implement the ticket requirements following existing patterns and conventions.
4. Write clean, production-quality code.
5. Do NOT create tests yet — that will be handled in a separate step.
6. Do NOT commit — just make the code changes.

## Guidelines
- Follow the existing code style exactly
- If you encounter something too complex or ambiguous, respond with "I cannot complete this" and explain why
- Prefer editing existing files over creating new ones
- Keep changes minimal and focused on the ticket requirements`;
}

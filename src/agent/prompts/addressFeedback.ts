export function addressFeedbackPrompt(params: {
  title: string;
  prComments: Array<{ user: string; body: string }>;
}) {
  return `You are addressing PR review feedback for a pull request.

## PR Title
${params.title}

## Review Comments
${params.prComments.map((c) => `**${c.user}:** ${c.body}`).join("\n\n")}

## Instructions
1. Read each review comment carefully.
2. Make the requested changes to the code.
3. If a comment is unclear or you disagree, still attempt the most reasonable interpretation.
4. Do NOT commit — just make the code changes.

## Guidelines
- Address ALL comments, not just some
- Follow the reviewer's style preferences
- Keep changes focused on what was requested`;
}

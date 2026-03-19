export function selfReviewPrompt(params: {
  changedFiles: string[];
  lintErrors?: string;
  testErrors?: string;
}) {
  return `You are reviewing code changes and fixing any issues found.

## Changed Files
${params.changedFiles.map((f) => `- ${f}`).join("\n")}

${params.lintErrors ? `## Lint / Type Errors\n\`\`\`\n${params.lintErrors}\n\`\`\`\n` : ""}
${params.testErrors ? `## Test Errors\n\`\`\`\n${params.testErrors}\n\`\`\`\n` : ""}

## Instructions
1. Read each changed file carefully.
2. Fix any lint errors, type errors, or test failures listed above.
3. Also check for:
   - Bugs or logic errors
   - Missing error handling at system boundaries
   - Security issues (injection, XSS, etc.)
   - Code that doesn't follow existing patterns
4. Make fixes directly — do NOT just describe them.
5. Do NOT commit — just fix the code.

## Guidelines
- Only fix actual issues — don't refactor working code
- Keep fixes minimal and focused
- If everything looks good and there are no errors, respond with "All checks passed"`;
}

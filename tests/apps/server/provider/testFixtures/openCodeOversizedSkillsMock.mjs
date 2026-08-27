// tests/apps/server/provider/testFixtures/openCodeOversizedSkillsMock.mjs
// emits bounded-test open code model and oversized skill discovery responses

if (process.argv[2] === 'models')
{
  process.stdout.write(
    'openai/gpt-test\n{"id":"gpt-test","providerID":"openai","name":"GPT Test"}\n',
  )
}
else if (process.argv[2] === 'debug')
{
  const content = 'x'.repeat(8 * 1024 * 1024 + 1)
  process.stdout.write('[{"name":"oversized","content":"' + content + '"}]')
}

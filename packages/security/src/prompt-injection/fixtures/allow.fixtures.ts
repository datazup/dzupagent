/**
 * Allow-list fixtures — strings that legitimately resemble fragments
 * of the injection patterns but are clearly benign.  None of these
 * MUST trigger a finding.
 */
export const ALLOW_FIXTURES: readonly string[] = [
  'Please summarize the document I just uploaded.',
  'What is the capital of France?',
  'Translate the previous paragraph to Spanish.',
  'Compare the prior quarter results with this quarter.',
  'I forgot my password — how do I reset it?',
  'Write a Python function that ignores empty rows in a CSV file.',
  'The instructions say to whisk the eggs gently before adding flour.',
  'Disregard the typo on line 3 of the report; the value is correct on line 4.',
  'Forget what I said earlier — I meant Tuesday, not Monday.',
  'Pretend play helps children develop empathy and language skills.',
  'Override the default timeout to 30 seconds in the config file.',
  'Could you act as a friendly customer-support agent in this draft?',
  'You are now connected to the production database; please run the migration.',
  'The instruction set extension AVX-512 is supported on this CPU.',
  'Render `<|im_start|>` literally inside this Markdown code block: `<|im_start|>`.',
  'Document the [INST] section of the LLaMA prompt format.',
  'My true purpose in this meeting is to capture action items.',
  'Please ignore extra whitespace when parsing the input.',
  'Disregard older typos in the legacy README.',
  'A jailbreak escape sequence is required to root the device.',
  'The DAN ratio represents domestic acquisition of nutrients.',
  'Translate the prior sentence into German.',
]

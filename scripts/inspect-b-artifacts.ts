import { readVoiceProfile, readAnchorWhitelist } from '@/lib/s3-chunks';

async function main() {
  const args = {
    bucket: 'textbooks-561764227438-us-east-1-an',
    pdfSha256: '3480da3ae9a353067c574924e296bee55b63adfb4af43cbb852a98fdd91e0394',
  };
  const [vp, aw] = await Promise.all([
    readVoiceProfile(args),
    readAnchorWhitelist(args),
  ]);
  console.log('=== VOICE PROFILE ===');
  console.log('tone:', vp?.tone_summary);
  console.log('signature_moves:');
  for (const m of vp?.signature_moves ?? []) console.log(`  - ${m.name}: ${m.description}`);
  console.log('example_phrases:');
  for (const p of vp?.example_phrases ?? []) console.log(`  - "${p.phrase}" [${p.ref}]`);
  console.log('humor:', vp?.humor_patterns);
  console.log('analogies:', vp?.preferred_analogies);
  console.log();
  console.log(`=== ANCHOR WHITELIST (${aw?.length ?? 0} entries) ===`);
  for (const a of aw ?? []) {
    console.log(`  ${a.term.padEnd(35)} freq=${a.frequency_in_source} cat=${a.category}`);
  }
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});

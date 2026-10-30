/**
 * What people have said about, and sent to, AEGIS — in public.
 *
 * Every entry quotes or describes something a reader can open: the
 * `href` is the comment, issue or pull request itself. Nothing here is
 * paraphrased praise or a composite. Add a quote only with its public
 * link (or the speaker's written permission, noted in `source`).
 */

export interface Voice {
  kind: 'quote' | 'contribution';
  name: string;
  handle: string;
  /** Who they are, only as they describe themselves publicly. */
  role?: string;
  avatar: string;
  /** For a quote, their words verbatim; for a contribution, what they sent. */
  text: string;
  source: string;
  href: string;
}

export const VOICES: Voice[] = [
  {
    kind: 'quote',
    name: 'Narnaiezzsshaa Truong',
    handle: '@narnaiezzsshaa',
    avatar: '/avatars/narnaiezzsshaa.webp',
    text: 'AEGIS is genuinely well-built for what it is—the cryptographic audit trail is thoughtful, the human-in-the-loop approval flow is the right instinct, and the one-line integration is clean.',
    source: 'DEV Community comment',
    href: 'https://dev.to/narnaiezzsshaa/comment/359hg',
  },
  {
    kind: 'contribution',
    name: 'Yue Zhao',
    handle: '@yzhao062',
    role: 'Assistant Professor, USC',
    avatar: '/avatars/yzhao062.webp',
    text: 'Tightened the README’s claims to match what the product does, and added gateway smoke tests for health, pre-execution checks and trace ingestion.',
    source: 'Pull request #1 · merged',
    href: 'https://github.com/Justin0504/Aegis/pull/1',
  },
  {
    kind: 'quote',
    name: 'flik',
    handle: '@flik1337',
    avatar: '/avatars/flik1337.webp',
    text: 'This is excellent work. We are trying to integrate it into our production agent service :)',
    source: 'GitHub issue #7',
    href: 'https://github.com/Justin0504/Aegis/issues/7#issuecomment-4778713474',
  },
  {
    kind: 'contribution',
    name: 'azizx4',
    handle: '@azizx4',
    avatar: '/avatars/azizx4.webp',
    text: 'A multi-step attack-pattern detector: read /etc/shadow, then POST it out — each step benign alone, blocked as a chain.',
    source: 'Pull request #5',
    href: 'https://github.com/Justin0504/Aegis/pull/5',
  },
  {
    kind: 'contribution',
    name: 'Omar Albeik',
    handle: '@omaralbeik',
    avatar: '/avatars/omaralbeik.webp',
    text: 'Took Syria out of the OFAC country packs after the sanctions programme ended (EO 14312), with the citation.',
    source: 'Pull request #11',
    href: 'https://github.com/Justin0504/Aegis/pull/11',
  },
  {
    kind: 'contribution',
    name: 'Hosameldeen Saleh',
    handle: '@deensaleh',
    role: 'Founder, Root Zero Vault',
    avatar: '/avatars/deensaleh.webp',
    text: 'Wired the gateway’s policy, bypass and anomaly tests into CI, and made the Python SDK install fail loudly.',
    source: 'Pull request #3',
    href: 'https://github.com/Justin0504/Aegis/pull/3',
  },
  {
    kind: 'contribution',
    name: 'Heewon Cha',
    handle: '@heevvy',
    avatar: '/avatars/heevvy.webp',
    text: 'Found the missing agent_profiles table that crashed a fresh gateway, with the root cause and the fix.',
    source: 'Issue #2',
    href: 'https://github.com/Justin0504/Aegis/issues/2',
  },
  {
    kind: 'contribution',
    name: 'githb-ac',
    handle: '@githb-ac',
    avatar: '/avatars/githb-ac.webp',
    text: 'Traced a broken stdio MCP handshake to startup logs on stdout, and asked for a stdio server mode.',
    source: 'Issue #4',
    href: 'https://github.com/Justin0504/Aegis/issues/4',
  },
  {
    kind: 'contribution',
    name: 'Yui',
    handle: '@cnYui',
    avatar: '/avatars/cnYui.webp',
    text: 'A regression test that starts the profile manager on a freshly initialised gateway database.',
    source: 'Pull request #8',
    href: 'https://github.com/Justin0504/Aegis/pull/8',
  },
  {
    kind: 'contribution',
    name: 'James',
    handle: '@cschanhniem',
    avatar: '/avatars/cschanhniem.webp',
    text: 'Dependabot for the monorepo’s npm workspaces and GitHub Actions, grouped weekly.',
    source: 'Pull request #6',
    href: 'https://github.com/Justin0504/Aegis/pull/6',
  },
];

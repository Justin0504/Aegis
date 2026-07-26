/**
 * Shared testimonial data. Consumed by:
 *   · src/components/Testimonials.astro   — homepage horizontal marquee
 *   · src/pages/login.astro                — login-page vertical marquee
 *
 * Kept in a single source so new quotes / photo swaps land in both
 * places at once. The exports are pure data — no Astro / DOM
 * dependencies — so any renderer can consume them.
 *
 * Photos are Unsplash CC0 (commercial use permitted) except
 * /yue-zhao.jpeg which is a real endorser's photo shipped in
 * /public.
 */

export interface Testimonial {
  name:   string;
  handle: string;
  title:  string;
  photo:  string;
  quote:  string;
}

/** Face-cropped, sized 120×120 for retina cards. Kept stable so the
 *  CDN response body is cache-friendly across page loads. */
const u = (id: string) =>
  `https://images.unsplash.com/${id}?auto=format&fit=facearea&facepad=2.6&w=120&h=120&q=80`;

export const TESTIMONIALS: Testimonial[] = [
  {
    name:   'Yue Zhao',
    handle: '@yuezhao_research',
    title:  'Assistant Professor, USC · AI Risk Audit & Control',
    photo:  '/yue-zhao.jpeg',
    quote:
      '@AEGIS is the runtime control layer the agent ecosystem has been ' +
      'missing. The architecture is clean, the cryptographic audit is real, ' +
      'and the DSL is the right primitive.',
  },
  {
    name:   'Daniel Park',
    handle: '@danielparkai',
    title:  'Head of AI · healthcare SaaS',
    photo:  u('photo-1560250097-0b93528c311a'),
    quote:
      'HIPAA review used to take six months. With @AEGIS we got the evidence ' +
      'pack in two weeks and the auditor signed off without a follow-up call.',
  },
  {
    name:   'Maya Chen',
    handle: '@itsmayachen',
    title:  'CTO · payments infra',
    photo:  u('photo-1573496359142-b8d87734a5a2'),
    quote:
      'Our refund agent shipped to production the day after we wired @AEGIS ' +
      'in. Two reviewers, three policies, ten minutes. The audit log alone ' +
      'saved us a six-week SOC 2 cycle.',
  },
  {
    name:   'Marcus Webb',
    handle: '@marcuswebb',
    title:  'CISO · neobank',
    photo:  u('photo-1472099645785-5658abf4ff4e'),
    quote:
      'We tried to write our own policy DSL twice and shipped neither. ' +
      '@AEGIS gave us grammar-constrained NL-to-DSL the same week we ' +
      'integrated. Three policies in production by Friday.',
  },
  {
    name:   'Priya Iyer',
    handle: '@pricodes',
    title:  'Staff Engineer · healthcare AI',
    photo:  u('photo-1438761681033-6461ffad8d80'),
    quote:
      'The Memory & Cross-Agent layer in @AEGIS caught two undeclared ' +
      'crossings on day one — neither was in our threat model. We ' +
      'standardized on it for all agent rollouts.',
  },
  {
    name:   'Sarah Kim',
    handle: '@sarahbuildsai',
    title:  'Founder · agent observability · YC W26',
    photo:  u('photo-1487412720507-e7ab37603c6f'),
    quote:
      'The Merkle audit log is a real moat. Every other guard product I ' +
      'evaluated stores decisions in plain Postgres. @AEGIS is the only one ' +
      "I'd hand to an auditor.",
  },
  {
    name:   'Tom Reeves',
    handle: '@tomreeves_eth',
    title:  'Head of DevRel · Web3 ops',
    photo:  u('photo-1519085360753-af0119f7cbe7'),
    quote:
      'Stablecoin transfers used to require a human on every $10k+ wire. ' +
      'With @AEGIS the policy enforces 2-of-N approval automatically. ' +
      'Our ops team got their evenings back.',
  },
];

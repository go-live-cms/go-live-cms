/**
 * Pure helpers for author bylines, "Written by" cards and the author page (#350).
 * Tested in authors.test.ts.
 */

// Who a byline credits, and the author page's website and count, are core's (src/lib/bylines.ts),
// shared with the post_byline (#489) and author page (#498) site blocks, so a block template and
// this theme say the same things the same way.
export { bylinePeople, displayName, nameSeparator, postCountLabel, safeWebsite, websiteLabel, type BylinePerson } from "@/lib/bylines"
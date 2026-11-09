-- Full-text search (#145) over post_search (000024_post_search). The query text
-- goes through websearch_to_tsquery, which accepts any input: quotes, OR and -
-- work, and everything else (& | ! ( <tags>) is just words or ignored, never a
-- syntax error. A query with no words left matches nothing.
--
-- Ranking: ts_rank's weights (A 1.0, B 0.4, C 0.2) put a title match above a
-- description or term match, and those above a body match; equal ranks go
-- newest first.

-- name: SearchPublicPosts :many
-- One page of the public search: published posts and pages of public, active
-- types that the public site serves (a published snapshot). The highlights are
-- ts_headline output with U+E000 / U+E001 around each match, sentinels taken out
-- of the source first, so the API can escape everything and add only <mark>
-- (search_utils.go). Headlines are built for the page's rows only.
-- excerpt_at_start / excerpt_at_end say whether the excerpt reaches the start
-- and end of its text (compared without sentinels, edge punctuation or extra
-- whitespace), so the page can show "…" where it was cut.
WITH q AS (
    SELECT websearch_to_tsquery(golive_search_config(), @query::text) AS tsq
), hits AS (
    -- The published title and excerpt (#358), which the document indexes too.
    SELECT p.id,
           COALESCE(p.published_settings->>'title', p.title)::text AS title,
           COALESCE(p.published_settings->>'description', p.description)::text AS description,
           p.slug, p.post_type, p.created_at, p.changed_at,
           ps.body_text, ts_rank(ps.document, q.tsq) AS rank
    FROM post_search ps
    JOIN posts p ON p.id = ps.post_id
    JOIN post_types pt ON pt.name = p.post_type AND pt.public AND pt.is_active
    CROSS JOIN q
    WHERE ps.document @@ q.tsq
      AND p.post_status = 'published'
      AND p.published_block_doc IS NOT NULL
      AND p.post_type IN ('post', 'page')
      AND (@post_type::text = '' OR p.post_type = @post_type::text)
    ORDER BY rank DESC, p.created_at DESC, p.id DESC
    LIMIT @limit_count
    OFFSET @offset_count
)
SELECT h.id, h.title, h.description, h.slug, h.post_type, h.created_at, h.changed_at, h.rank,
       ts_headline(golive_search_config(), translate(h.title, chr(57344) || chr(57345), ''), q.tsq,
           'HighlightAll=true, StartSel=' || chr(57344) || ', StopSel=' || chr(57345))::text AS title_highlight,
       x.excerpt::text AS excerpt_highlight,
       (left(x.plain, 24) = left(x.source, 24))::boolean AS excerpt_at_start,
       (right(x.plain, 24) = right(x.source, 24))::boolean AS excerpt_at_end,
       -- The published category in the hit's URL (#331).
       coalesce(golive_post_category_slug(h.id, true), '')::text AS category_slug
FROM hits h
CROSS JOIN q
CROSS JOIN LATERAL (
    SELECT e.excerpt,
           regexp_replace(regexp_replace(translate(e.excerpt, chr(57344) || chr(57345), ''), '\s+', ' ', 'g'), '^[^[:alnum:]]+|[^[:alnum:]]+$', '', 'g') AS plain,
           regexp_replace(regexp_replace(e.source, '\s+', ' ', 'g'), '^[^[:alnum:]]+|[^[:alnum:]]+$', '', 'g') AS source
    FROM (
        -- A short text (about 40 words) is shown whole: fragment mode would cut it
        -- to a few words around the match. A longer one as up to two fragments.
        SELECT s.source,
               ts_headline(golive_search_config(), s.source, q.tsq,
                   CASE WHEN length(s.source) <= 280
                     THEN 'HighlightAll=true, StartSel=' || chr(57344) || ', StopSel=' || chr(57345)
                     ELSE 'MaxFragments=2, MaxWords=30, MinWords=12, FragmentDelimiter=" … ", StartSel=' || chr(57344) || ', StopSel=' || chr(57345)
                   END) AS excerpt
        FROM (
            SELECT translate(concat_ws(E'\n', nullif(h.description, ''), nullif(h.body_text, '')), chr(57344) || chr(57345), '') AS source
        ) s
    ) e
) x
ORDER BY h.rank DESC, h.created_at DESC, h.id DESC;

-- name: CountPublicSearchResults :many
-- The public search's matches per type, for the All / Posts / Pages chips and
-- the total. Same filters as SearchPublicPosts, without the type.
SELECT p.post_type, COUNT(*) AS total
FROM post_search ps
JOIN posts p ON p.id = ps.post_id
JOIN post_types pt ON pt.name = p.post_type AND pt.public AND pt.is_active
WHERE ps.document @@ websearch_to_tsquery(golive_search_config(), @query::text)
  AND p.post_status = 'published'
  AND p.published_block_doc IS NOT NULL
  AND p.post_type IN ('post', 'page')
GROUP BY p.post_type;

-- name: SearchPostsWithMeta :many
-- The admin posts list's search: the list's filters (type, status, owner) plus
-- the search, ranked. Same columns as ListPostsWithMeta, so the handler shapes
-- rows the same way. Drafts match on title, description and terms; their
-- working copy is never indexed. The index has a published post's published
-- title and excerpt (#358), and the list shows its working ones, so those match
-- too: a post renamed but not yet updated is found by its new name.
SELECT
    p.id, p.title, p.description, p.user_id, p.username, p.url,
    p.post_type, p.post_status, p.post_parent, p.menu_order, p.created_at, p.changed_at, p.published_block_doc, p.slug, p.published_settings,
    golive_post_has_unpublished_changes(p.id, p.post_status, p.block_doc_hash, p.published_block_hash, p.published_settings)::boolean AS has_unpublished_changes,
    p.publish_at,
    p.deleted_at, p.trashed_from_status,
    su.update_at,
    (
        SELECT COALESCE(jsonb_object_agg(pm.meta_key, pm.meta_value), '{}'::jsonb)
        FROM post_meta pm
        WHERE pm.post_id = p.id
    ) as meta,
    -- The working byline (#319): the admin list's avatars.
    golive_post_byline(p.id)::jsonb as authors,
    -- The working category in the post's URL (#331), as ListPostsWithMeta.
    coalesce(golive_post_category_slug(p.id, false), '')::text AS category_slug
FROM post_search ps
JOIN posts p ON p.id = ps.post_id
-- The scheduled update (#335), as in ListPostsWithMeta.
LEFT JOIN post_scheduled_updates su ON su.post_id = p.id
WHERE
    (ps.document @@ websearch_to_tsquery(golive_search_config(), @query::text)
     OR (p.published_settings IS NOT NULL
         AND to_tsvector(golive_search_config(), p.title || ' ' || p.description)
             @@ websearch_to_tsquery(golive_search_config(), @query::text))
     -- #327's "search by title and slug": part of a word ("collab" finds
     -- "collaboration") and slugs, which the index doesn't hold. title_pattern is
     -- '%<q>%' with LIKE wildcards escaped; these rank after every index match.
     OR (@title_pattern::text <> '' AND (p.title ILIKE @title_pattern::text OR p.slug ILIKE @title_pattern::text)))
    AND (@post_type::text = '' OR p.post_type = @post_type)
    -- status: one status or a comma list; none = every status but the trash (#327).
    AND (CASE WHEN @post_status::text = '' THEN p.post_status <> 'trash'
              ELSE p.post_status = ANY(string_to_array(replace(@post_status::text, ' ', ''), ',')) END)
    -- Filters (#327), as in ListPosts: byline author, and every term given.
    AND (@author_id::bigint = 0 OR EXISTS (SELECT 1 FROM user_posts fa WHERE fa.post_id = p.id AND fa.user_id = @author_id::bigint))
    AND NOT EXISTS (
        SELECT 1 FROM unnest(@term_ids::bigint[]) AS ft(id)
        WHERE NOT EXISTS (SELECT 1 FROM post_taxonomy_relationships fr WHERE fr.post_id = p.id AND fr.taxonomy_term_id = ft.id)
    )
    AND (@user_id::bigint = 0 OR p.user_id = @user_id)
    -- What the caller may read (#393): 0 = everything (moderators, /public); a
    -- contributor's id = their own posts plus published ones (canReadPost).
    AND (@viewer_id::bigint = 0 OR p.user_id = @viewer_id OR p.post_status = 'published')
    AND (NOT @unpublished_changes::boolean
         OR golive_post_has_unpublished_changes(p.id, p.post_status, p.block_doc_hash, p.published_block_hash, p.published_settings))
    -- Review requested (#323), as in ListPosts.
    AND (NOT @review_pending::boolean OR (EXISTS (SELECT 1 FROM review_requests rr WHERE rr.post_id = p.id AND rr.status = 'open') AND (@viewer_id::bigint = 0 OR p.user_id = @viewer_id)))
ORDER BY ts_rank(ps.document, websearch_to_tsquery(golive_search_config(), @query::text)) DESC, p.created_at DESC, p.id DESC
LIMIT @limit_count
OFFSET @offset_count;

-- name: SearchCommandPalettePosts :many
-- The admin command palette (#41): the first @limit_per_type posts and pages the viewer may
-- read whose title or slug contains the text (@pattern, @prefix_pattern: ILIKE patterns the
-- API escapes), titles that start with it first, then the latest edited. Never the trash.
-- It runs on every pause in typing, so no ranking or tsvector: SearchPostsWithMeta took
-- seconds at 30,000 posts, and this is one scan.
SELECT hits.id, hits.title, hits.post_type, hits.post_status
FROM (
    SELECT p.id, p.title, p.post_type, p.post_status,
           row_number() OVER (
               PARTITION BY p.post_type
               ORDER BY (p.title ILIKE @prefix_pattern::text) DESC, GREATEST(p.changed_at, p.created_at) DESC, p.id DESC
           ) AS position
    FROM posts p
    WHERE p.post_type IN ('post', 'page')
      AND p.post_status <> 'trash'
      AND (@viewer_id::bigint = 0 OR p.user_id = @viewer_id OR p.post_status = 'published')
      AND (p.title ILIKE @pattern::text OR p.slug ILIKE @pattern::text)
) hits
WHERE hits.position <= @limit_per_type::int
ORDER BY hits.post_type, hits.position;

-- name: CountSearchPosts :one
-- SearchPostsWithMeta's total, with the same filters.
SELECT COUNT(*) AS total
FROM post_search ps
JOIN posts p ON p.id = ps.post_id
WHERE
    (ps.document @@ websearch_to_tsquery(golive_search_config(), @query::text)
     OR (p.published_settings IS NOT NULL
         AND to_tsvector(golive_search_config(), p.title || ' ' || p.description)
             @@ websearch_to_tsquery(golive_search_config(), @query::text))
     -- #327's "search by title and slug": part of a word ("collab" finds
     -- "collaboration") and slugs, which the index doesn't hold. title_pattern is
     -- '%<q>%' with LIKE wildcards escaped; these rank after every index match.
     OR (@title_pattern::text <> '' AND (p.title ILIKE @title_pattern::text OR p.slug ILIKE @title_pattern::text)))
    AND (@post_type::text = '' OR p.post_type = @post_type)
    -- status: one status or a comma list; none = every status but the trash (#327).
    AND (CASE WHEN @post_status::text = '' THEN p.post_status <> 'trash'
              ELSE p.post_status = ANY(string_to_array(replace(@post_status::text, ' ', ''), ',')) END)
    -- Filters (#327), as in ListPosts: byline author, and every term given.
    AND (@author_id::bigint = 0 OR EXISTS (SELECT 1 FROM user_posts fa WHERE fa.post_id = p.id AND fa.user_id = @author_id::bigint))
    AND NOT EXISTS (
        SELECT 1 FROM unnest(@term_ids::bigint[]) AS ft(id)
        WHERE NOT EXISTS (SELECT 1 FROM post_taxonomy_relationships fr WHERE fr.post_id = p.id AND fr.taxonomy_term_id = ft.id)
    )
    AND (@user_id::bigint = 0 OR p.user_id = @user_id)
    -- What the caller may read (#393): 0 = everything (moderators, /public); a
    -- contributor's id = their own posts plus published ones (canReadPost).
    AND (@viewer_id::bigint = 0 OR p.user_id = @viewer_id OR p.post_status = 'published')
    AND (NOT @unpublished_changes::boolean
         OR golive_post_has_unpublished_changes(p.id, p.post_status, p.block_doc_hash, p.published_block_hash, p.published_settings))
    AND (NOT @review_pending::boolean OR (EXISTS (SELECT 1 FROM review_requests rr WHERE rr.post_id = p.id AND rr.status = 'open') AND (@viewer_id::bigint = 0 OR p.user_id = @viewer_id)));

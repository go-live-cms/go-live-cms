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
    SELECT p.id, p.title, p.description, p.slug, p.post_type, p.created_at, p.changed_at,
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
       (right(x.plain, 24) = right(x.source, 24))::boolean AS excerpt_at_end
FROM hits h
CROSS JOIN q
CROSS JOIN LATERAL (
    SELECT e.excerpt,
           regexp_replace(regexp_replace(translate(e.excerpt, chr(57344) || chr(57345), ''), '\s+', ' ', 'g'), '^[^[:alnum:]]+|[^[:alnum:]]+$', '', 'g') AS plain,
           regexp_replace(regexp_replace(e.source, '\s+', ' ', 'g'), '^[^[:alnum:]]+|[^[:alnum:]]+$', '', 'g') AS source
    FROM (
        -- A short text is shown whole (fragment mode would cut it to a few words
        -- around the match); a longer one as up to two fragments.
        SELECT s.source,
               ts_headline(golive_search_config(), s.source, q.tsq,
                   CASE WHEN cardinality(regexp_split_to_array(btrim(s.source), '\s+')) <= 40
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
-- working copy is never indexed.
SELECT
    p.id, p.title, p.description, p.user_id, p.username, p.url,
    p.post_type, p.post_status, p.post_parent, p.menu_order, p.created_at, p.changed_at, p.published_block_doc, p.slug,
    (
        SELECT COALESCE(jsonb_object_agg(pm.meta_key, pm.meta_value), '{}'::jsonb)
        FROM post_meta pm
        WHERE pm.post_id = p.id
    ) as meta,
    (
        SELECT COALESCE(
            jsonb_agg(jsonb_build_object('id', u.id, 'username', u.username, 'full_name', u.full_name) ORDER BY up."order", u.id),
            '[]'::jsonb
        )
        FROM user_posts up
        JOIN users u ON u.id = up.user_id
        WHERE up.post_id = p.id
    )::jsonb as authors
FROM post_search ps
JOIN posts p ON p.id = ps.post_id
WHERE
    ps.document @@ websearch_to_tsquery(golive_search_config(), @query::text)
    AND (@post_type::text = '' OR p.post_type = @post_type)
    AND (@post_status::text = '' OR p.post_status = ANY(string_to_array(replace(@post_status::text, ' ', ''), ',')))
    AND (@user_id::bigint = 0 OR p.user_id = @user_id)
ORDER BY ts_rank(ps.document, websearch_to_tsquery(golive_search_config(), @query::text)) DESC, p.created_at DESC, p.id DESC
LIMIT @limit_count
OFFSET @offset_count;

-- name: CountSearchPosts :one
-- SearchPostsWithMeta's total, with the same filters.
SELECT COUNT(*) AS total
FROM post_search ps
JOIN posts p ON p.id = ps.post_id
WHERE
    ps.document @@ websearch_to_tsquery(golive_search_config(), @query::text)
    AND (@post_type::text = '' OR p.post_type = @post_type)
    AND (@post_status::text = '' OR p.post_status = ANY(string_to_array(replace(@post_status::text, ' ', ''), ',')))
    AND (@user_id::bigint = 0 OR p.user_id = @user_id);

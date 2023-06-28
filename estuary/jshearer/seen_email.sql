-- First we want to keep track of every email we see
INSERT INTO emails (
    id,
    from_email,
    to_email,
    body,
    normalized_subject,
    date,
    data
) SELECT
    $id,
    $properties$hs_email_from_email,
    $properties$hs_email_to_email,
    $properties$hs_email_text,
    -- We're going to use the normalized subject as part of our thread grouping
    REPLACE(LOWER($properties$hs_email_subject), 're: ',''),
    $createdAt,
    $flow_document
-- Updates to source documents are represented by re-emitting a document with
-- the same key as the original. In that case we'd get a conflict when trying
-- to perform the insert, so let's handle that by updating the existing record
ON CONFLICT DO UPDATE SET
    from_email = $properties$hs_email_from_email,
    to_email = $properties$hs_email_to_email,
    body = $properties$hs_email_text,
    normalized_subject = REPLACE(LOWER($properties$hs_email_subject), 're: ',''),
    date = $createdAt,
    data = $flow_document;

-- Let's idempotently keep track of the companies that this email address
-- is associatd with.
INSERT INTO email_companies (email_id, company_id)
SELECT $id, value
FROM JSON_EACH($companies)
WHERE TRUE
ON CONFLICT DO NOTHING;

-- Now we figure out what documents to emit from the derivation. Note that since
-- this is still inside the `seen_email.sql` file, this gets executed every time
-- we see an email document. 

-- Recursive CTE to build up the chain of messages in this thread, starting from
-- the current message and walking up to the next message that shares a normalized subject
-- and was sent to the recipient of the current message.
WITH RECURSIVE
    message_tree(id, from_email, to_email, normalized_subject, data) as (
        SELECT id, from_email, to_email, normalized_subject, data FROM emails WHERE emails.id=$id
        UNION
        SELECT parent_message.id, parent_message.from_email, parent_message.to_email, parent_message.normalized_subject, parent_message.data
        FROM emails as parent_message, message_tree as current_message
        WHERE parent_message.to_email = current_message.from_email
        AND parent_message.normalized_subject = current_message.normalized_subject
    )
-- Now we group together all of the messages in the thread into a single JSON array
SELECT
    MIN(message_tree.id) as id,
    JSON_GROUP_ARRAY(DISTINCT JSON(companies.data)) FILTER (WHERE companies.id IS NOT NULL) as companies,
    JSON_GROUP_ARRAY(JSON(message_tree.data)) as messages
FROM message_tree
-- Enrich thread data with associated companies
LEFT OUTER JOIN email_companies ON email_companies.email_id = message_tree.id
LEFT OUTER JOIN companies on companies.id = email_companies.company_id
GROUP BY companies.id
HAVING COUNT(message_tree.id) > 2;
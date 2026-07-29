-- Report paths move from "<client>-end-of-month-report" to
-- "<client>-monthly-reports".
--
-- A report path is normally permanent and never regenerated, because the link
-- may already be sitting in a client's inbox. This is the one deliberate
-- exception: the format itself changed, and it is safe to do now precisely
-- because no client is holding a real link yet. The only published report
-- lives on the spare Netlify site on a throwaway netlify.app address, which
-- has never been sent to anyone.
--
-- The transform only swaps the trailing suffix, so distinct paths stay
-- distinct and the unique index cannot be violated. It covers the numbered
-- disambiguation form ("acme-2-end-of-month-report") for the same reason.
--
-- `reportUrl` is left alone on purpose. The page at the old path is still
-- served, since a Netlify deploy preserves files it does not replace, so the
-- existing link keeps working until the next publish writes the new path and
-- updates this column.

UPDATE "Client"
SET "reportSlug" = regexp_replace("reportSlug", '-end-of-month-report$', '-monthly-reports')
WHERE "reportSlug" LIKE '%-end-of-month-report';

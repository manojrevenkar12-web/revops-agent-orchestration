-- Support tickets opened in the last 30 days for one account. Parameters: @account_id
SELECT severity, status, opened
FROM `${project}.support.tickets`
WHERE account_id = @account_id
ORDER BY opened DESC

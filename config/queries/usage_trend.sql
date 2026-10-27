-- Weekly product usage for one account, oldest first. Parameters: @account_id
SELECT week_start, active_process_instances, active_users, clusters
FROM `${project}.product.product_usage_weekly`
WHERE account_id = @account_id
ORDER BY week_start

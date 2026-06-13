# Police---DC-Bot
The ultimate moderation bot for discord.
# Commands
## Moderation:
- **/warning give:** Gives a warning to a user.
- **/warning remove:** Manually removes the selected warning from a user.
- **/timeout give:** Gives a configurable length timeout to a user.
- **/timeout remove:** Remove the timeout from a user.
- **/kick:** Kicks the user
- **/ban give:** Bans the user and deletes their messages in the last (configurable time). Can also be set to unban after set time.
- **/ban remove:** Unbans the user.
## Config:
- **/config set:** Config the warning levels by matching them to roles and setting how long they take to expire.
- **/config access:** Config what role is needed to access mod commands like /warn and /config.
- **/config logchannel:** Sets which channel the embeds go to and let's you remove it.
- **/config notifications:** Toggles DM's to users on or off.
- **/config view:** Shows your current warning configuration and allows you to delete configurations.
## Escalation:
- **/escalation set:** Configure how many level X warnings you need to automatically bump up to a level Y.
- **/escalation cap:** Sets the cap of the warnings, where any additional warning won't escalate.
- **/escalation timeout:** Adds a special threshold where the user gets a configurable timeout.
- **/escalation view:** Shows the current escalation setup and let's you delete levels, timeout levels and the cap.
## Scam Protection:
- **/scam add:** Upload a known scam image to register it. Any similar image posted in the server will be automatically removed.
- **/scam config:** Configure scam protection settings including enabling/disabling detection, whether to delete messages, timeout duration, and similarity threshold.
- **/scam list:** Lists all registered scam images with their IDs, labels, who added them and let's you delete them.
## Spam Protection:
- **/spam config:** Configure spam detection settings including enabling/disabling, how many similar messages trigger it, the time window, similarity threshold, whether to delete messages, and timeout duration.
- **/spam view:** Shows the current spam protection configuration.
## Messages:
- **/messages delete:** Delete messages in one channel with filters like only deleting from a specific user, deleting in the last x hours and setting the amount of messages deleted.
- **/messages purge:** Delete all of the selected users messages across all channels that were sent in the last x hours.
## Admin:
- **/warning history:** Shows the warning history of a specific user.
- **/warning list:** Shows all active warning in the server.
- **/userinfo:** View account info, roles, active warnings, warn counts per level, kicks, bans, and notes for any user.
## Notes:
- **/note add:** Adds a note to a user.
- **/note remove:** Views all of the users notes and gives you the option to delete them.
## Other
- **/help:** Shows all commands available.
- **/mywarnings:** Shows you how much time is left on your warnings.
- **/invite:** Creates an invite for the bot with all the permissions the bot needs.

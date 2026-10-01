import type {
  Client,
  GuildMember,
  PartialGuildMember,
} from "discord.js-selfbot-v13";
import { createChildLogger } from "@/shared/logger/index";
import { isMonitoredGuild } from "../../shared/config/guildScope.js";
import { config } from "../../shared/config/index.js";
import type { EventBroadcaster } from "../event-broadcaster/eventBroadcaster.js";

const logger = createChildLogger("guild-member-events");

export function registerGuildMemberEvents(
  client: Client,
  eventBroadcaster: EventBroadcaster,
): void {
  logger.info("Registering guild member events");

  client.on("guildMemberAdd", async (member: GuildMember) => {
    if (!isMonitoredGuild(config, member.guild.id)) return;

    const data = {
      user_id: member.id,
      username: member.user.username,
      tag: member.user.tag ?? null,
      avatar_url: member.user.avatarURL() ?? null,
      guild_id: member.guild.id,
      member_count: member.guild.memberCount,
      joined_at: Date.now(),
    };

    logger.info(
      { userId: member.id, username: member.user.username },
      "Guild member added",
    );
    await eventBroadcaster.guildMemberAdded(data).catch(() => {});
  });

  client.on(
    "guildMemberRemove",
    async (member: GuildMember | PartialGuildMember) => {
      if (!isMonitoredGuild(config, member.guild.id)) return;

      const data = {
        user_id: member.id,
        username: (member.user as any)?.username ?? "unknown",
        tag: (member.user as any)?.tag ?? null,
        guild_id: member.guild.id,
        member_count: member.guild.memberCount,
        removed_at: Date.now(),
      };

      logger.info(
        { userId: member.id, username: member.user?.username },
        "Guild member removed",
      );
      await eventBroadcaster.guildMemberRemoved(data).catch(() => {});
    },
  );
}

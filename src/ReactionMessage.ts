import {
    MessageReaction, 
    User,
    EmojiIdentifierResolvable,
    Message,
    DiscordAPIError
} from "discord.js";

import {compareEmoji} from './util';
import {ComparisonSet} from './ComparisonSet';
import {EmojiMap} from './EmojiMap';

export interface ReactionCallback<T> {
    (reaction: MessageReaction, user: User): T;
}

interface ReactionCallbacks {
    /** Called when receiving the reaction, return false to remove the reaction (button behaviour) otherwise the reaction will stay */
    collect?: ReactionCallback<boolean | void>;
    remove?: ReactionCallback<void>;
    dispose?: ReactionCallback<void>;
    /** Validate whether a user's reaction should remain or not - return true to keep a reaction, false to remove */
    validate?: ReactionCallback<boolean>;
    /** Return true to display the option (have the bot react with at least 1) */
    condition?: () => boolean;
}

type CallbackMethodName = 'collect' | 'remove' | 'dispose';

export interface ReactionOption extends ReactionCallbacks {
    emoji: EmojiIdentifierResolvable;
}

export class ReactionMessage {
    message: Message;
    optionMap: EmojiMap<ReactionOption>;
    defaultOption: ReactionCallbacks;
    constructor(message: Message, options: ReactionOption[], defaultOption?: ReactionCallbacks) {
        this.message = message;
        this.optionMap = new EmojiMap<ReactionOption>(message.client, options);
        this.defaultOption = defaultOption;

        this.rebuildReactions().then(this.createReactionCollector);
    }

    private callbackProxy = (callbackMethodName: CallbackMethodName) => (reaction: MessageReaction, user: User): void => {
        if(user !== user.client.user) {
            const callback = this.getCallback(reaction);
            if(callback) {
                if(callback[callbackMethodName]) {
                    const result = callback[callbackMethodName](reaction, user);
                    if(callbackMethodName === 'collect' && result === false) {
                        reaction.users.remove(user);
                    }
                }
            }
        }

        this.rebuildReactions();
    };

    private createReactionCollector = (): void => {
        this.message.createReactionCollector((_, user)=>{
            return user != user.client.user;
        }, {
            dispose: true
        })
            .on('collect', this.callbackProxy('collect'))
            .on('remove', this.callbackProxy('remove'))
            .on('dispose', this.callbackProxy('dispose'));
    };

    getOption(reaction: MessageReaction): ReactionOption {
        return this.optionMap.get(reaction.emoji);
    }

    getCallback(reaction: MessageReaction): ReactionCallbacks {
        const callback = this.optionMap.get(reaction.emoji);

        return callback || this.defaultOption;
    }

    addOption(option: ReactionOption): void {
        this.optionMap.add(option);
        this.rebuildReactions();
    }

    removeOption(option: ReactionOption): void {
        this.optionMap.remove(option);
        this.rebuildReactions();
    }

    async rebuildReactions(): Promise<void |MessageReaction[]> {
        this.message = await this.message.fetch();

        const existingReactions = new ComparisonSet(compareEmoji);
        const promises = [];

        for(const reaction of this.message.reactions.cache.array()) {
            promises.push(reaction.users.fetch().then((users)=>{
                if(users.size) {
                    const option = this.getOption(reaction);
                    if(!option || (option.condition && !option.condition())) {
                        if(this.defaultOption && this.defaultOption.validate && !this.defaultOption.validate(reaction, null)) {
                            reaction.remove();
                        } else {
                            reaction.users.remove(this.message.client.user);
                        }
                    } else if(option) {
                        existingReactions.add(option.emoji);
                    }
    
                    if(option && option.validate) {
                        for(const user of users.array()) {
                            if(user !== user.client.user && !option.validate(reaction, user)) {
                                reaction.users.remove(user);
                            }
                        }
                    }
                }
            }));
        }

        await Promise.all(promises);

        const reactionPromises: Promise<MessageReaction>[] = [];
        for(const option of this.optionMap.getValues()) {
            if(!existingReactions.has(option.emoji) && (!option.condition || option.condition())) {
                reactionPromises.push(this.message.react(option.emoji));
            }
        }

        return Promise.all(reactionPromises).catch(e=>{
            if(!(e instanceof DiscordAPIError) || e.code === 404) {
                throw e;
            }
        });
    }
}
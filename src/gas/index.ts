export const MAX_EXPIRATION = 60 * 60 * 6;
const {
  BOT_ID,
  CLIENT_ID,
  CLIENT_SECRET,
  GPT_KEY,
  code_verifier: CODE_VERIFIER,
  PROMPT,
  REPLY_PROMPT,
  SEARCH_QUERY,
  SILENT_MODE = 1,
  MAX_RESULTS = 10,
  IMPRESSIONS = -1,
} = PropertiesService.getScriptProperties().getProperties();

const silentMode = !!+SILENT_MODE;

function mapChoice(choice): string {
  const result = choice?.text?.trim() || ``;

  if (result.startsWith(`0`)) return ``;

  const trimResult = result
    .replace(/0[."]*$/, ``)
    .replace(/^"/, ``)
    .replace(/"$/, ``);

  return trimResult.length < 10 ? `` : trimResult;
}

function debunkWithGPT(tweet: string, prompt: string): string {
  const neuralNetPrompt = `${prompt}\n\nTweet:\n${tweet}\n\nDebunk/confirmation:`;

  const maxTweetSize = 280;
  const tokenSize = 4;
  const response = UrlFetchApp.fetch(`https://api.openai.com/v1/completions`, {
    method: `post`,
    contentType: `application/json`,
    headers: {
      Authorization: `Bearer ${GPT_KEY}`,
    },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      model: `text-davinci-003`,
      max_tokens: maxTweetSize / tokenSize,
      prompt: neuralNetPrompt,
    }),
  });

  if (response.getResponseCode() >= 300) {
    throw new Error(
      `ChatGPT failed ${response.getResponseCode()}: ${response.getContentText()}`
    );
  }

  const gptReply = JSON.parse(response.getContentText());
  console.log(`Choices`, gptReply?.choices);
  const clearReply = gptReply?.choices?.map(mapChoice).find((c) => c.length);
  return clearReply || ``;
}

global.tick = function () {
  let lastMentionId = CacheService.getScriptCache().get(
    `lastMentionId`
  ) as string;

  const service = getService();
  if (!service.hasAccess()) {
    if (lastMentionId) {
      CacheService.getScriptCache().put(
        `lastMentionId`,
        lastMentionId,
        MAX_EXPIRATION
      );
    }
    const authorizationUrl = service.getAuthorizationUrl();
    throw new Error(
      `Authorization failed. Open the following URL and re-run the script: ${authorizationUrl}`
    );
  }

  let url = `https://api.twitter.com/2/users/${BOT_ID}/mentions?max_results=5&expansions=referenced_tweets.id&tweet.fields=author_id,public_metrics`;
  if (lastMentionId) {
    url += `&since_id=${lastMentionId}`;
  }
  const response = UrlFetchApp.fetch(url, {
    headers: {
      "User-Agent": `v2UserMentionssJS`,
      authorization: `Bearer ${service.getAccessToken()}`,
    },
  });

  const mentions = JSON.parse(response.getContentText());
  console.log(`mentions`, mentions);
  console.log(`included tweets`, mentions.includes?.tweets);

  mentions?.data?.forEach((m: any) => {
    console.log(`mention`, m);

    const refTweet = mentions.includes?.tweets?.[0];
    const isNewConversation = !refTweet?.text.match(/@pleasedebunk/gi);
    const notOwnReply = refTweet?.author_id !== BOT_ID;
    if (isNewConversation && notOwnReply) {
      console.log(`ref tweet`, refTweet);
      // Use mention text if no ref tweet
      // Remove mentions from tweet
      const text = (refTweet?.text || m.text).replace(/@\w+/g, ``);
      const result = debunkWithGPT(text, REPLY_PROMPT);
      if (!silentMode) {
        reply(result || `I can't tell with confidence. #DYOR 🫡`, m.id);
      }
    }

    if (!silentMode) {
      lastMentionId = m.id;
    }
  });

  if (lastMentionId) {
    CacheService.getScriptCache().put(
      `lastMentionId`,
      lastMentionId,
      MAX_EXPIRATION
    );
  }
};

/**
 * Create the OAuth2 Twitter Service
 * @return OAuth2 service
 */
function getService(): any {
  pkceChallengeVerifier();
  const store = PropertiesService.getScriptProperties();
  return (
    // @ts-expect-error
    OAuth2.createService(`twitter`)
      .setAuthorizationBaseUrl(`https://twitter.com/i/oauth2/authorize`)
      .setTokenUrl(
        `https://api.twitter.com/2/oauth2/token?code_verifier=` +
          (store.getProperty(`code_verifier`) as string)
      )
      // Set the client ID and secret.
      .setClientId(CLIENT_ID)
      .setClientSecret(CLIENT_SECRET)
      .setCallbackFunction(`authCallback`)
      // Set the property store where authorized tokens should be persisted.
      .setPropertyStore(store)
      .setCache(CacheService.getScriptCache())
      // Set the scopes to request (space-separated for Twitter services).
      .setScope(`users.read tweet.read offline.access tweet.write`)

      // Add parameters in the authorization url
      .setParam(`response_type`, `code`)
      .setParam(`code_challenge_method`, `S256`)
      .setParam(`code_challenge`, store.getProperty(`code_challenge`))
      .setTokenHeaders({
        Authorization:
          `Basic ` + Utilities.base64Encode(CLIENT_ID + `:` + CLIENT_SECRET),
        "Content-Type": `application/x-www-form-urlencoded`,
      })
  );
}

/**
 * Reset the OAuth2 Twitter Service
 */
global.reset = function () {
  getService().reset();
  PropertiesService.getScriptProperties().deleteProperty(`code_challenge`);
  PropertiesService.getScriptProperties().deleteProperty(`code_verifier`);
};

/**
 * Generate PKCE Challenge Verifier for Permission for OAuth2 Twitter Service
 */
function pkceChallengeVerifier(): void {
  if (!CODE_VERIFIER) {
    let verifier = ``;
    const possible = `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~`;
    for (let i = 0; i < 128; i++) {
      verifier += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    const sha256hash = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256,
      verifier
    );
    const challenge = Utilities.base64Encode(sha256hash)
      .replace(/\+/g, `-`)
      .replace(/\//g, `_`)
      .replace(/=+$/, ``);
    const store = PropertiesService.getScriptProperties();
    store.setProperty(`code_verifier`, verifier);
    store.setProperty(`code_challenge`, challenge);
  }
}

/**
 * Handles the OAuth callback.
 */
global.authCallback = function (request) {
  const service = getService();
  const authorized = service.handleCallback(request);
  if (authorized) {
    return HtmlService.createHtmlOutput(`Success!`);
  } else {
    return HtmlService.createHtmlOutput(`Denied`);
  }
};

/**
 * Send the Tweet
 * @Param tweet Text to tweet
 * @Param replyTo id of the tweet to reply
 * @return the ID of the current Tweet
 */
function reply(tweet: string, replyTo: string): void {
  const url = `https://api.twitter.com/2/tweets`;
  const response = UrlFetchApp.fetch(url, {
    method: `post`,
    contentType: `application/json`,
    muteHttpExceptions: true,
    headers: {
      "User-Agent": `v2TweetJS`,
      authorization: `Bearer ${getService().getAccessToken()}`,
    },
    payload: JSON.stringify({
      text: tweet,
      reply: { in_reply_to_tweet_id: replyTo },
    }),
  });
  if (response.getResponseCode() >= 300) {
    throw new Error(
      `Error posting tweet ${response.getResponseCode()}: ${response.getContentText()}`
    );
  }
  console.log(response.getContentText());
}

/**
 * Send the Tweet
 * @Param tweet Text to tweet
 * @Param replyTo id of the tweet to reply
 * @return the ID of the current Tweet
 */
function retweetWithComment(comment: string, tweetId: string): void {
  const url = `https://api.twitter.com/2/tweets`;
  const response = UrlFetchApp.fetch(url, {
    method: `post`,
    contentType: `application/json`,
    muteHttpExceptions: true,
    headers: {
      "User-Agent": `v2TweetJS`,
      authorization: `Bearer ${getService().getAccessToken()}`,
    },
    payload: JSON.stringify({
      text: comment,
      quote_tweet_id: tweetId,
    }),
  });
  if (response.getResponseCode() >= 300) {
    throw new Error(
      `Error posting tweet ${response.getResponseCode()}: ${response.getContentText()}`
    );
  }
  console.log(response.getContentText());
}

function getCheckedTweetIdsFromCache(): string[] {
  const ids = CacheService.getScriptCache().get(`checkedTweetIds`);
  return ids ? JSON.parse(ids) : [];
}

function saveCheckedTweetIdsToCache(checkedTweetIds: string[]): void {
  const cache = CacheService.getScriptCache();
  // Keep only the last 500 checked tweets
  checkedTweetIds = checkedTweetIds.slice(-500);
  cache.put(`checkedTweetIds`, JSON.stringify(checkedTweetIds), MAX_EXPIRATION);
}

/**
 * Fetches recent tweets that do not contain any media (only text),
 * and contain the phrase "is it true?".
 * Then debunks them.
 */
global.debunkRecentTweets = function () {
  const url = `https://api.twitter.com/2/tweets/search/recent?tweet.fields=created_at,public_metrics&${SEARCH_QUERY}&max_results=${MAX_RESULTS}`;
  const response = UrlFetchApp.fetch(url, {
    method: `get`,
    contentType: `application/json`,
    headers: {
      "User-Agent": `v2RecentSearchJS`,
      authorization: `Bearer ${getService().getAccessToken()}`,
    },
  });

  const result = JSON.parse(response.getContentText());

  const impressions = +IMPRESSIONS;
  const checkedTweetIds = getCheckedTweetIdsFromCache();
  const tweets = result.data?.filter(
    (t) =>
      // Only tweets that >= 50 symbols excluding mentions
      t.text.replace(/@\w+/g, ``).length >= 50 &&
      // Reply only non-replied tweets
      t.public_metrics.reply_count === 0 &&
      //  That have enough impressions
      (impressions < 0 || t.public_metrics.impression_count >= impressions) &&
      // That have not been checked before
      !checkedTweetIds.includes(t.id)
  );
  if (tweets?.length) {
    tweets.reverse().forEach((tweet: any) => {
      console.log(tweet);
      try {
        Utilities.sleep(1000); // cool down
        // Remove mentions from tweet
        const text = tweet.text.replace(/@\w+/g, ``);
        const debunkText = debunkWithGPT(text, PROMPT);
        if (!silentMode && debunkText) {
          Utilities.sleep(4000); // cool down
          retweetWithComment(debunkText, tweet.id);
        }
        checkedTweetIds.push(tweet.id);
      } catch (e) {
        console.error(e);
      }
    });
  }

  saveCheckedTweetIdsToCache(checkedTweetIds);
};

/**
 * Created by kenzo on 2017/06/28.
 */
"use strict";
require('dotenv').config();
const restify = require('restify');
const builder = require('botbuilder');
const ticketApi = require('./ticketApi');
const listenPort = process.env.port || process.env.PORT || 3978;
const ticketSubmissionUrl = process.env.TICKET_SUBMISSION_URL || `http://localhost:${listenPort}`;
const fs = require('fs');
var luisRecognizer = new builder.LuisRecognizer(process.env.LUIS_MODEL_URL).onEnabled((context, callback) => {
    var enabled = context.dialogStack().length === 0;
    callback(null, enabled);
});

const createCard = (ticketId, data) => {
    var cardTxt = fs.readFileSync('./cards/ticket.json', 'UTF-8');

    cardTxt = cardTxt.replace(/{ticketId}/g, ticketId)
        .replace(/{importance}/g, data.importance)
        .replace(/{category}/g, data.category)
        .replace(/{problem}/g, data.problem)
        .replace(/{date}/g, data.date);

    return JSON.parse(cardTxt);
};

// Setup Restify Server
var server = restify.createServer();



// Create chat connector for communicating with the Bot Framework Service
var connector = new builder.ChatConnector({
    appId: process.env.MICROSOFT_APP_ID,
    appPassword: process.env.MICROSOFT_APP_PASSWORD
});

const azureSearch = require('./azureSearchApiClient');

const azureSearchQuery = azureSearch({
    searchName: process.env.AZURE_SEARCH_ACCOUNT,
    indexName: process.env.AZURE_SEARCH_INDEX,
    searchKey: process.env.AZURE_SEARCH_KEY
});

// Listen for messages from users
server.post('/api/messages', connector.listen());

server.use(restify.bodyParser());
server.post('/api/tickets', ticketApi);

server.listen(listenPort,'::',() => {
    console.log('サーバー起動');
});


// Receive messages from the user and respond by echoing each message back (prefixed with 'You said:')
var bot = new builder.UniversalBot(connector);
bot.recognizer(luisRecognizer);

// // Add first run dialog
// bot.dialog('firstRun', function (session) {
//     var name = session.dialogData.username ? session.dialogData.username : null;
//     session.userData.firstRun = true;
//     session.send("Thanks %s for inviting me. May I help you?", name || 'there');
//     builder.Prompts.choice(session,"重要度を教えてください",["software", "hardware", "networking", "security","other"],{listStyle: builder.ListStyle.button});
// }).triggerAction({
//     onFindAction: function (context, callback) {
//         // Only trigger if we've never seen user before
//         if (!context.userData.firstRun) {
//             // Return a score of 1.1 to ensure the first run dialog wins
//             callback(null, 1.1);
//         } else {
//             callback(null, 0.0);
//         }
//     }
// });

bot.dialog('SolveProblems', [
    // 実行する順番に関数をセッティングしていく
    (session, args, next) => {
    console.log(args.intent);
        var importanceEntity = builder.EntityRecognizer.findEntity(args.intent.entities, 'Importance');
        session.dialogData.importance = importanceEntity.resolution.values[0];
        console.log(session.dialogData.importance);
        session.send('At first,What your problem of category?');
        builder.Prompts.choice(session,"Choose one category!",["software", "hardware", "networking", "security","other"],{listStyle: builder.ListStyle.button});
    },
    (session, result, next) => {
        // dialogData = その会話文中のみ有効なデータ
        session.dialogData.category = result.response.entity;
        builder.Prompts.text(session,'How about your problem?');
    },
    (session,result, next) => {
        session.dialogData.problem = result.response;
        // 入力したテキストに応じて、重要度を判定。確認を取る。
        session.send(`Is it right that your ${session.dialogData.category} problem is ${session.dialogData.problem}. This problem is ${session.dialogData.importance}`);
        builder.Prompts.confirm(session,"Yes or No",{ listStyle: builder.ListStyle.button });
    },
    (session, result, next) => {
        if (result.response) {
            var data = {
                category: session.dialogData.category,
                importance: session.dialogData.importance,
                problem: session.dialogData.problem,
                date: new Date()
            };


            const client = restify.createJsonClient({url: ticketSubmissionUrl});

            client.post('/api/tickets', data, (err, request, response, ticketId) => {
                if (err || ticketId == -1) {
                    session.send('Something went wrong while I was saving your ticket. Please try again later.')
                } else {
                    session.sendTyping();
                    setTimeout(function () {
                        session.send(new builder.Message(session).addAttachment({
                            contentType: "application/vnd.microsoft.card.adaptive",
                            content: createCard(ticketId, data)
                        }));
                    }, 3000);
                }
                session.endDialog();
            });
        } else {
            session.endDialog('Ok. The ticket was not created. You can start again if you want.');
        }
    }
]).triggerAction({
    matches: 'SolveProblems'
});

bot.dialog('SearchKB', [
    (session) => {
        session.sendTyping();
        azureSearchQuery(`search=${encodeURIComponent(session.message.text.substring('search about '.length))}`, (err, result) => {
            if (err) {
                session.send('Ooops! Something went wrong while contacting Azure Search. Please try again later.');
                return;
            }
            session.replaceDialog('ShowKBResults', { result, originalText: session.message.text });
        });
    }
]).triggerAction({
        matches: /^search about (.*)/i
});

bot.dialog('ExploreKnowledgeBase', [
    (session, args, next) => {
        var category = builder.EntityRecognizer.findEntity(args.intent.entities, 'category');

        if (!category) {
            // retrieve facets
            azureSearchQuery('facet=category', (error, result) => {
                if (error) {
                    session.endDialog('Ooops! Something went wrong while contacting Azure Search. Please try again later.');
                } else {
                    var choices = result['@search.facets'].category.map(item=> `${item.value} (${item.count})`);
                    builder.Prompts.choice(session, 'Let\'s see if I can find something in the knowledge base for you. Which category is your question about?', choices, { listStyle: builder.ListStyle.button });
                }
            });
        } else {
            if (!session.dialogData.category) {
                session.dialogData.category = category.entity;
            }

            next();
        }
    },
    (session, args) => {
        var category;

        if (session.dialogData.category) {
            category = session.dialogData.category;
        } else {
            category = args.response.entity.replace(/\s\([^)]*\)/,'');
        }

        // search by category
        azureSearchQuery('$filter=' + encodeURIComponent(`category eq '${category}'`), (error, result) => {
            if (error) {
                session.endDialog('Ooops! Something went wrong while contacting Azure Search. Please try again later.');
            } else {
                session.replaceDialog('ShowKBResults', { result, originalText: category });
            }
        });
    }
]).triggerAction({
    matches: 'ExploreKnowledgeBase'
});


bot.dialog('Help',
    (session, args, next) => {
        session.endDialog(`I'm the help desk bot and I can help you create a ticket or explore the knowledge base.\n` +
            `You can tell me things like _I need to reset my password_ or _explore hardware articles_.`);
    }
).triggerAction({
    matches: /help/i
});

bot.dialog('DetailsOf', [
    (session, args) => {
        var title = session.message.text.substring('show me the article '.length);
        azureSearchQuery('$filter=' + encodeURIComponent(`title eq '${title}'`), (error, result) => {
            if (error || !result.value[0]) {
                session.endDialog('Sorry, I could not find that article.');
            } else {
                session.endDialog(result.value[0].text);
            }
        });
    }
]).triggerAction({
    matches: /^show me the article (.*)/i
});

bot.dialog('ShowKBResults', [
    (session, args) => {
        if (args.result.value.length > 0) {
            var msg = new builder.Message(session).attachmentLayout(builder.AttachmentLayout.carousel);
            args.result.value.forEach((faq, i) => {
                msg.addAttachment(
                    new builder.ThumbnailCard(session)
                        .title(faq.title)
                        .subtitle(`Category: ${faq.category} | Search Score: ${faq['@search.score']}`)
                        .text(faq.text.substring(0, Math.min(faq.text.length, 50) + '...'))
                        .images([builder.CardImage.create(session, 'https://bot-framework.azureedge.net/bot-icons-v1/bot-framework-default-7.png')])
                        .buttons([{ title: 'More details', value: `show me the article ${faq.title}`, type: 'postBack' }])
                );
            });
            session.send(`These are some articles I\'ve found in the knowledge base for _'${args.originalText}'_, click **More details** to read the full article:`);
            session.endDialog(msg);
        } else {
            session.endDialog(`Sorry, I could not find any results in the knowledge base for _'${args.originalText}'_`);
        }
    }
]);


bot.on('conversationUpdate', function (message) {
    var name = message.user ? message.user.name : null;
    var reply = new builder.Message()
        .address(message.address)
        .text("Thanks %s for inviting me. May I help you?", name || 'there');
    bot.send(reply);
});
/**
 * Created by kenzo on 2017/06/28.
 */
"use strict"
var tickets = [];
var lastTicketId = 1;

module.exports = (req, res) => {
    console.log('Ticket received: ', req.body);
    let ticketId = lastTicketId++;
    var ticket = req.body;
    ticket.id = ticketId;
    tickets.push(ticket);

    res.send(ticketId.toString());
};
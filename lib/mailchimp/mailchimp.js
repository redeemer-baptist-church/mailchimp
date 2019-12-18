const MailchimpApi = require('mailchimp-api-v3')
const {MailingList} = require('./mailing_list')
const {Member} = require('./member')
const {Template} = require('./template')

require('array.prototype.flat').shim()

class Mailchimp {
  constructor(apiKey) {
    this.client = new MailchimpApi(apiKey)
  }

  get lists() {
    return this._lists || this.getLists()
  }

  get members() {
    return this._members || this.getMembers()
  }

  get templates() {
    return this._templates || this.getTemplates()
  }

  getTemplates() {
    console.log('Mailchimp is getting all templates')
    this._templates = this.client.batch({
      method: 'get',
      path: '/templates',
      params: {
        type: 'user',
      },
    }).then(json => json.templates.map(list => new Template(list, this.client)))
    return this._templates
  }

  getLists() {
    console.log('Mailchimp is getting all mailing lists')
    this._lists = this.client.batch({
      method: 'get',
      path: '/lists',
    }).then(json => json.lists.map(list => new MailingList(list, this.client)))
    return this._lists
  }

  getMembers() {
    const self = this
    this._members = this.lists.then((lists) => {
      lists.map(list => console.log(`Batch getting members for list ${list.id} - "${list.name}"`))
      const calls = lists.map(list => ({
        method: 'get',
        path: `/lists/${list.id}/members`,
      }))
      // eslint-disable-next-line arrow-body-style
      return self.client.batch(calls).then((results) => {
        return results.map(json => json.members.map(member => new Member(member))).flat()
      })
    })
    return this._members
  }
}

module.exports = {Mailchimp}

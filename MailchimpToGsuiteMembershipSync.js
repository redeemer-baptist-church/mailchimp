require('dotenv').config() // load gcloud credentials in dev

const pluralize = require('pluralize')
const uniqBy = require('lodash/uniqBy')

const {
  ManagerFactory: GSuiteManagerFactory,
} = require('@redeemerbc/gsuite')
const {Secret} = require('@redeemerbc/secret')
const {Mailchimp} = require('./lib/mailchimp')

require('array.prototype.flat').shim()

class MailchimpToGsuiteMembershipSync {
  async run() {
    this.gsuiteServiceAccount = await new Secret('GsuiteServiceAccount').get()
    this.mailchimpApiKey = await new Secret('MailchimpApiKey').get()

    this.mailchimpGroupedUsers = await this.getMailchimpGroupedUsers()

    await this.syncGroupsFromMailchimpToGoogle()
    await this.syncUsersFromMailchimpIntoGoogleGroups()

    await this.syncUsersFromMailchimpIntoGoogleContacts()
  }

  async getMailchimpGroupedUsers() { // eslint-disable-line class-methods-use-this
    const mailchimp = new Mailchimp(this.mailchimpApiKey)
    return mailchimp.members.reduce((tagGroups, member) => {
      member.tags.forEach((tag) => {
        const tagName = pluralize.plural(tag.name)
        const group = tagGroups[tagName] || []
        group.push({
          email: member.email.toLowerCase(),
          name: member.name,
          firstName: member.firstName,
          lastName: member.lastName,
        })
        tagGroups[tagName] = group // eslint-disable-line no-param-reassign
      })
      return tagGroups
    }, {})
  }

  async syncGroupsFromMailchimpToGoogle() {
    const mailchimpGroups = Object.keys(this.mailchimpGroupedUsers).map(group => group.toLowerCase())

    console.info('Synching these Mailchimp groups to GSuite:', mailchimpGroups)
    const scopes = [
      'https://www.googleapis.com/auth/admin.directory.group', // admin access to create/update groups of users XXX: is there a better auth for groups?
    ]
    const manager = await GSuiteManagerFactory
      .groupManager(scopes, this.gsuiteServiceAccount, {domain: 'redeemerbc.com'})

    const gsuiteGroups = await manager.getGroups().then(groups => groups.map(group => group.name.toLowerCase()))
    console.info('GSuite reports these groups:', gsuiteGroups)

    const groupsToCreate = mailchimpGroups.filter(g => !gsuiteGroups.includes(g))
    console.info('These groups exist in Mailchimp but not in GSuite:', groupsToCreate)
    await manager.createGroups(groupsToCreate)

    const groupsToDelete = gsuiteGroups.filter(g => !mailchimpGroups.includes(g))
    console.info('These groups exist in GSuite but not in Mailchimp:', groupsToDelete)
    await manager.deleteGroups(groupsToDelete)
  }

  async syncUsersFromMailchimpIntoGoogleGroups() {
    const scopes = [
      'https://www.googleapis.com/auth/admin.directory.group', // admin access to create/update groups of users
    ]
    const manager = await GSuiteManagerFactory
      .groupManager(scopes, this.gsuiteServiceAccount, {domain: 'redeemerbc.com'})
    Object.entries(this.mailchimpGroupedUsers).forEach(async ([group, groupedUsers]) => {
      const mailchimpUsers = groupedUsers.map(user => user.email).sort()
      console.info(`Synching these Mailchimp users to GSuite group '${group}':`, mailchimpUsers)

      const gsuiteUsers = await manager.getUsers(group).then(users => users.map(user => user.email))
      console.info('GSuite reports these users:', gsuiteUsers)

      const usersToDelete = gsuiteUsers.filter(u => !mailchimpUsers.includes(u))
      console.info(`These users exist in GSuite but not in Mailchimp group ${group}:`, usersToDelete)
      await manager.deleteUsers(usersToDelete, group)

      const usersToCreate = mailchimpUsers.filter(u => !gsuiteUsers.includes(u))
      console.info(`These users exist in Mailchimp but not in GSuite group ${group}:`, usersToCreate)
      await manager.insertUsers(usersToCreate, group)
    })
  }

  async syncUsersFromMailchimpIntoGoogleContacts() {
    const mailchimpUsers = uniqBy(Object.values(this.mailchimpGroupedUsers).flat(), 'email')
    const mailchimpUserEmails = mailchimpUsers.map(user => user.email).sort()
    console.info('Synching these Mailchimp users to GSuite contacts:', mailchimpUserEmails)

    const gsuiteContacts = await this.getGSuiteContacts()
    const gsuiteContactEmails = gsuiteContacts.map(user => user.email).sort()
    console.info('GSuite reports these users:', gsuiteContactEmails)

    // TODO: sync first/last name changes from Mailchimp to here; usersToUpdate

    const scopes = [
      'https://www.googleapis.com/auth/contacts', // read/write acccess to contact lists
    ]
    const manager = await GSuiteManagerFactory.peopleManager(scopes, this.gsuiteServiceAccount)

    const usersToDelete = gsuiteContacts.filter(u => !mailchimpUserEmails.includes(u.email))
    console.info('These users exist in GSuite but not in Mailchimp contacts:', usersToDelete)
    await manager.deleteContacts(usersToDelete.map(user => user.resourceName))

    const usersToCreate = mailchimpUsers.filter(u => !gsuiteContactEmails.includes(u.email))
    console.info('These users exist in Mailchimp but not in GSuite contacts:', usersToCreate)
    await manager.createContacts(usersToCreate)
  }

  async getGSuiteContacts() {
    const scopes = [
      'https://www.googleapis.com/auth/contacts.readonly', // read-only acccess to contact lists
    ]
    const manager = await GSuiteManagerFactory.peopleManager(scopes, this.gsuiteServiceAccount)

    return manager.getContacts({
      personFields: 'names,emailAddresses',
    })
  }
}

new MailchimpToGsuiteMembershipSync().run()
  .catch((e) => {
    console.log(e)
    throw e
  })

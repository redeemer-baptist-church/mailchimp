require('dotenv').config() // load gcloud credentials in dev

const camelCase = require('lodash/camelCase')
const cheerio = require('cheerio')
const dayjs = require('dayjs')
const pretty = require('pretty')
const unirest = require('unirest')
const SpotifyWebApi = require('spotify-web-api-node')
const url = require('url')

const {
  ManagerFactory: GSuiteManagerFactory,
} = require('@redeemerbc/gsuite')
const {SecretClient} = require('@redeemerbc/secret')
const {serialize} = require('@redeemerbc/serialize')
const {Mailchimp} = require('./lib/mailchimp')
const {PeopleMapper} = require('./lib/redeemerbc')

class MailchimpNewsletterGenerator {
  async run() {
    this.mailchimpApiKey = await new SecretClient().read('MailchimpApiKey')

    this.peopleMapper = await this.buildGSuitePeopleMapper()
    await this.publishMailchimpNewsletterTemplate()
  }

  get serviceDate() { // eslint-disable-line class-methods-use-this
    return dayjs().startOf('week').add(1, 'weeks')
  }

  async buildGSuitePeopleMapper() {
    const gsuiteContacts = await this.getGSuiteContacts()
    return new PeopleMapper(gsuiteContacts)
  }

  async getGSuiteContacts() { // eslint-disable-line class-methods-use-this
    const scopes = [
      'https://www.googleapis.com/auth/contacts.readonly', // read-only acccess to contact lists
    ]
    const manager = await GSuiteManagerFactory.peopleManager(scopes)

    return manager.getContacts({
      personFields: 'names,emailAddresses',
    })
  }

  async buildEventsHtmlForCalendar(date, calendar) {
    return calendar.getEvents({
      singleEvents: true,
      timeMax: date.endOf('day').toISOString(),
      timeMin: date.subtract(6, 'days').toISOString(),
    }).then((events) => {
      if (events.length === 0) {
        return ''
      }
      const calendarLink = `https://calendar.google.com/calendar?cid=${calendar.id}`
      const calendarHtml = `<dt><b><a href="${calendarLink}">${calendar.summary}</a></b></dt>`
      const eventsHtml = events.map((event) => {
        const eventLabel = event.label.replace(`${calendar.summary} - `, '')
        const attendees = event.attendees.map(attendee => this.peopleMapper.personByEmail(attendee).fullName)
          .join(', ') || event.description
        return `<dd><i>${eventLabel}</i>: ${attendees}</dd>`
      }).join('')
      return `${calendarHtml} ${eventsHtml}`
    })
  }

  async getAllCalendars() { // eslint-disable-line class-methods-use-this
    const scopes = [
      'https://www.googleapis.com/auth/calendar.readonly', // read-only acccess to calendar entries
    ]
    const manager = await GSuiteManagerFactory.calendarManager(scopes)
    // TODO: filter out Scripture Reading and other non-human calendars
    const calendars = await manager.getCalendars()
      .then(calendarList => calendarList
        .filter(calendar => !calendar.primary)
        .sort((a, b) => a.summary.localeCompare(b.summary)))
    console.info(`Google reports these calendars: ${calendars.map(c => c.summary)}`)
    return calendars
  }

  async getCalendarHtml(date, calendars) {
    const calendarHtml = await serialize(calendars.map(calendar => () => this
      .buildEventsHtmlForCalendar(date, calendar)))
      .then(htmlArray => `<dl>${htmlArray.filter(Boolean).join('')}</dl>`)
    const dateText = date.format('MMMM D, YYYY')
    const dateHtml = `<span style="font-family:merriweather,georgia,times new roman,serif;font-size:16px">
      <strong> - ${dateText}</strong>
    </span>`

    return `${dateHtml}${calendarHtml}`
  }

  async getScriptureReferencesFromCalendar() {
    const scopes = [
      'https://www.googleapis.com/auth/calendar.readonly', // read-only acccess to calendar entries
    ]
    const manager = await GSuiteManagerFactory.calendarManager(scopes)
    const calendarId = 'redeemerbc.com_gmiihbof3pt28k6lngkoufabqk@group.calendar.google.com'
    const calendar = await manager.getCalendar(calendarId)

    return calendar.getEvents({
      singleEvents: true,
      timeMax: this.serviceDate.endOf('day').toISOString(),
      timeMin: this.serviceDate.subtract(6, 'days').toISOString(),
    }).then(events => events.reduce((table, e) => {
      const htmlId = camelCase(e.label.replace(`${calendar.summary} - `, ''))
      const passages = e.description.split('\n')
      table[htmlId] = passages // eslint-disable-line no-param-reassign
      return table
    }, {}))
  }

  async getSermonPassage(reference) { // eslint-disable-line class-methods-use-this
    console.info(`Getting ESV text for passage ${reference}`)
    const esvApiKey = await new SecretClient().read('EsvApiKey')
    return unirest.get('https://api.esv.org/v3/passage/html/')
      .headers({Authorization: esvApiKey})
      .query({
        q: reference,
        'include-footnotes': false,
        'include-headings': false,
        'include-subheadings': false,
        'include-short-copyright': false,
      })
      .then(response => response.body.passages[0])
  }

  async getSermonPassageHtml(reference) {
    const passage = await this.getSermonPassage(reference)
    return `${passage}<a href="http://esv.to/${reference}" target="_blank">Read the full passage here</a>`
  }

  async buildSermonPassageHtml(references) {
    return serialize(references.map(reference => () => this.getSermonPassageHtml(reference)))
      .then(html => html.join(''))
  }

  async getSpotifyTracks(playlistId) { // eslint-disable-line class-methods-use-this
    console.info(`Getting Spotify tracks for playlist ${playlistId}`)
    const clientId = await new SecretClient().read('SpotifyClientId')
    const clientSecret = await new SecretClient().read('SpotifyClientSecret')
    const spotifyApi = new SpotifyWebApi({clientId, clientSecret})

    await spotifyApi.clientCredentialsGrant()
      .then(json => spotifyApi.setAccessToken(json.body.access_token))

    // TODO: Make tracks an object with a sanitizeTrackName() method
    return spotifyApi.getPlaylist(playlistId)
      .then(json => json.body.tracks.items.map(item => item.track.name
        .replace(' - Live', '')
        .replace(' (Acoustic)', '')))
  }

  async getTemplateHtmlFromMailchimp() {
    const templateId = 359089
    const mailchimp = new Mailchimp(this.mailchimpApiKey)

    console.info(`Creating temporary Mailchimp campaign based on template ${templateId}`)
    // TODO: extract into mailchimp.createCampaign()
    return mailchimp.client.post('/campaigns', {
      type: 'regular',
      settings: {
        title: 'RedeemerBot - Temporary Campaign To Extract Template HTML',
        template_id: templateId,
      },
    }).then(async (json) => {
      console.info(`Getting template HTML from Mailchimp for generated campaign ${json.id}`)
      const html = await mailchimp.client.get(`/campaigns/${json.id}/content`).then(contentJson => contentJson.html)
      console.info(`Deleting temporary Mailchimp campaign ${json.id}`)
      await mailchimp.client.delete(`/campaigns/${json.id}`)
      return html
    })
  }

  async publishMailchimpNewsletterTemplate() {
    const mailchimp = new Mailchimp(this.mailchimpApiKey)

    const templateHtml = await this.getTemplateHtmlFromMailchimp()
    const $ = cheerio.load(templateHtml)

    // replace the sermon date
    $("[data-redeemer-bot='sermonDate']").text(this.serviceDate.format('dddd, MMMM D, YYYY'))

    // replace the sermon passages
    const references = await this.getScriptureReferencesFromCalendar()
    $("[data-redeemer-bot='scriptureReading']").html(await this.buildSermonPassageHtml(references.scriptureReading))
    $("[data-redeemer-bot='sermonPassage']").html(await this.buildSermonPassageHtml(references.sermonPassage))

    // replace the Spotify playlist
    const spotifyPlaylistUrl = 'https://open.spotify.com/playlist/2HoaFy0dLN5hs0EbMcUdJU'
    const spotifyPlaylistId = url.parse(spotifyPlaylistUrl).pathname.split('/').slice(-1)[0]
    const tracks = await this.getSpotifyTracks(spotifyPlaylistId)
    const spotifyUrl = `https://open.spotify.com/playlist/${spotifyPlaylistId}`
    const youtubeUrl = 'https://music.youtube.com/playlist?list=PLt11S0kjDvef_xLiQv103MdVRe1LiPGG0'
    const playlistLink = `<b>This week's playlist, on <a href="${spotifyUrl}">Spotify</a>`
      + ` and <a href="${youtubeUrl}">YouTube</a></b><br />`
    $("[data-redeemer-bot='serviceMusic']").html(`${playlistLink}<br />${tracks.join('<br />')}`)

    const calendars = await this.getAllCalendars()
    const thisWeekCalendarHtml = await this.getCalendarHtml(this.serviceDate, calendars)
    const nextWeekCalendarHtml = await this.getCalendarHtml(this.serviceDate.add(1, 'week'), calendars)
    // TODO: add CSS around this so the pretty template looks good
    $("[data-redeemer-bot='thisWeekCalendar']").html(thisWeekCalendarHtml)
    $("[data-redeemer-bot='nextWeekCalendar']").html(nextWeekCalendarHtml)

    console.info('Publishing the fully fleshed out HTML template to Mailchimp')
    await mailchimp.client.patch('/templates/359109', {
      name: 'RedeemerBot - Processed Newsletter Template',
      html: pretty($.html(), {ocd: true}),
    }).then(json => console.log(json))
  }
}

new MailchimpNewsletterGenerator().run()
  .catch((e) => {
    console.log(e)
    throw e
  })

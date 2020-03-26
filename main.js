'use strict'

/**
 * @todo get settings from command line either by
 * - arguments
 * - prompt (with inquirer)
 */
const settings = {
  campaignDate: new Date('2020-03-25'),
  campaignTitle: 'Inaktive Abonnenten Entfernen',
  tagName: 'Inactive',
  confirmationUrl: 'createrawvision.de/newsletter-abo-bestaetigt'
}

const axois = require('axios').default
const Confirm = require('prompt-confirm')

require('dotenv').config()
const API_KEY = process.env.MAILCHIMP_API_KEY
if (!API_KEY) throw new Error('No API Key provided')
const dc = API_KEY.split('-').reverse()[0]
const args = process.argv.slice(2)
const DRY_RUN = args.some(arg => ['-d', '--dry'].includes(arg))
const FORCE_DELETE = args.some(arg => ['-f', '--force'].includes(arg))

const api = axois.create({
  baseURL: `https://${dc}.api.mailchimp.com/3.0`,
  auth: {
    username: 'subscriber-cleaning',
    password: API_KEY
  }
})

/**
 * Add full days to a given date
 *
 * @param {Date} date
 * @param {number} days the number of days to add
 * @returns {Date} date with days added
 */
const addDays = (date, days) => {
  var result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}

/**
 * Get the campaign id and recipient list id for a campaign at a given date with title
 *
 * @param {Date} date when the campaign was sent
 * @param {string} title the exact title of the campaign
 * @returns {Promise<{campaignId: string, listId: string}>} campaign id and recipient list id
 */
const getCampaignInfo = async (date, title) => {
  const {
    data: { campaigns }
  } = await api.get('/campaigns', {
    params: {
      fields: ['campaigns.id', 'campaigns.settings.title', 'campaigns.recipients.list_id'].join(','),
      since_send_time: date.toISOString(),
      before_send_time: addDays(date, 1).toISOString()
    }
  })
  const matchingCampaigns = campaigns.filter(c => c.settings.title === title)
  if (matchingCampaigns.length !== 1) throw new Error(`Found ${matchingCampaigns.length} matching campaigns. Response was ${campaigns}`)
  return {
    campaignId: matchingCampaigns[0].id,
    listId: matchingCampaigns[0].recipients.list_id
  }
}

/**
 * Find all links in a campaign that match the confirmationUrl (by substring or exaclty)
 *
 * @param {string} campaignId the id of the campain to search
 * @param {string} confirmationUrl the url to search for
 * @param {boolean} [exact=false] if true, urls have to match exactly, otherwise confirmationUrl has to be a substring
 * @returns {Promise<Array<string>>} the ids of the links
 */
const getLinkIds = async (campaignId, confirmationUrl, exact = false) => {
  let {
    data: { urls_clicked: urlsClicked }
  } = await api.get(`/reports/${campaignId}/click-details`, {
    params: { fields: ['urls_clicked.id', 'urls_clicked.url'].join(',') }
  })
  urlsClicked = urlsClicked.filter(({ url }) =>
    exact ? url === confirmationUrl : url.includes(confirmationUrl)
  )
  return urlsClicked.map(url => url.id)
}

/**
 * Find a tag by name inside a list
 *
 * @param {string} listId list id for the tag
 * @param {string} tagName exact name of the tag
 * @returns {Promise<string>} id for the given tag
 */
const getTagId = async (listId, tagName) => {
  const { data: { segments } } = await api.get(`/lists/${listId}/segments`, {
    params: {
      fields: ['segments.id', 'segments.name'].join(','),
      type: 'static'
    }
  })
  const tags = segments.filter(seg => seg.name === tagName)
  if (!tags.length) throw new Error('Found no matching tag')
  return tags[0].id
}

/**
 * Get all tagged members in list
 *
 * @param {string} listId
 * @param {string} tagId
 * @returns {Promise<Array<{id: string, emailAddress: string}>>} member info (id is md5 hash of lowercase email)
 */
const getMembersByTag = async (listId, tagId) => {
  const { data: { members, total_items: totalItems } } = await api.get(`/lists/${listId}/segments/${tagId}/members`, {
    params: {
      fields: ['members.id', 'members.email_address', 'total_items'].join(','),
      count: 1000
    }
  })
  if (members.length < totalItems) throw new Error('Function not implemented for that many members')
  return members.map(({ id, email_address: emailAddress }) => ({ id, emailAddress }))
}

/**
 * Get all members that clicked the link in the campaign
 *
 * @param {string} campaignId
 * @param {string} linkId
 * @returns {Promise<Array<{id: string, emailAddress: string}>>} member info (id is md5 hash of lowercase email)
 */
const getMembersWhichClickedLink = async (campaignId, linkId) => {
  const { data: { members, total_items: totalItems } } = await api.get(`/reports/${campaignId}/click-details/${linkId}/members`, {
    params: {
      fields: ['members.email_id', 'members.email_address', 'total_items'].join(','),
      count: 1000
    }
  })
  if (members.length < totalItems) throw new Error('Function not implemented for that many members')
  return members.map(({ email_id: id, email_address: emailAddress }) => ({ id, emailAddress }))
}

/**
 * Starts a batch operation to archive all members, after confirmation.
 *
 * @param {string} listId
 * @param {Array<string>} memberIds
 * @returns {string} id of the created batch
 */
const archiveMembers = async (listId, memberIds) => {
  if (DRY_RUN) {
    console.log(`Would archive ${memberIds.length} members`)
    return
  }
  if (!FORCE_DELETE) {
    const prompt = new Confirm(`Delete ${memberIds.length} members?`)
    const confirmDelete = await prompt.run()
    if (!confirmDelete) return
  }
  const { data: { id: batchId } } = await api.post('/batches', {
    operations: memberIds.map(memberId => ({
      method: 'DELETE',
      path: `/lists/${listId}/members/${memberId}`,
      operation_id: String(memberId)
    }))
  })
  return batchId
}

/**
 * Determines:
 * - the campaign and corresponding list
 * - the link and all members that clicked it
 * - the tag and all its members
 *
 * Then archives all members with the given tag, that haven't clicked the link
 *
 * @param {{campaign: {date: Date, title: string}, tagName: string, confirmationUrl: string}} settings
 */
const run = async (settings) => {
  const { campaignDate, campaignTitle, tagName, confirmationUrl } = settings
  console.log(`Sending request for ${JSON.stringify(settings, null, 2)}`)

  const { campaignId, listId } = await getCampaignInfo(campaignDate, campaignTitle)
  console.log(`Received campaignId ${campaignId} and listId ${listId}`)

  const linkIds = await getLinkIds(campaignId, confirmationUrl)
  console.log(`Received linkIds ${linkIds.join(' ')}`)

  const tagId = await getTagId(listId, tagName)
  console.log(`Received tagId ${tagId}`)

  const members = await getMembersByTag(listId, tagId)
  console.log(`Received ${members.length} members`)

  const membersClicked = []
  for (const linkId of linkIds) {
    membersClicked.push(...await getMembersWhichClickedLink(campaignId, linkId))
  }
  console.log(`${membersClicked.length} clicks received`)

  const membersMap = new Map()
  members.forEach(({ id, emailAddress }) => membersMap.set(id, emailAddress))
  membersClicked.forEach(member => membersMap.delete(member.id))

  const batchId = await archiveMembers(listId, [...membersMap.keys()])
  if (batchId) console.log(`Archiving members by batch operation with ID ${batchId}`)
}

run(settings)

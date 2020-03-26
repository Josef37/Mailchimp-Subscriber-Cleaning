const axois = require('axios').default
const Confirm = require('prompt-confirm')

require('dotenv').config()
const API_KEY = process.env.MAILCHIMP_API_KEY
if (!API_KEY) throw new Error('No API Key provided')
const dc = API_KEY.split('-').reverse()[0]
const args = process.argv.slice(2)
const DRY_RUN = args.some(arg => ['-d', '--dry'].includes(arg))
const FORCE_DELETE = args.some(arg => ['-f', '--force'].includes(arg))

const settings = {
  campaign: {
    date: new Date('2020-03-25'),
    title: 'Inaktive Abonnenten Entfernen'
  },
  tag: 'Inactive',
  confirmationUrl: 'createrawvision.de/newsletter-abo-bestaetigt'
}

const api = axois.create({
  baseURL: `https://${dc}.api.mailchimp.com/3.0`,
  auth: {
    username: 'subscriber-cleaning',
    password: API_KEY
  }
})

const addDays = (date, days) => {
  var result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}

const getCampaignInfo = async () => {
  const {
    data: { campaigns }
  } = await api.get('/campaigns', {
    params: {
      fields: ['campaigns.id', 'campaigns.settings.title', 'campaigns.recipients.list_id'].join(','),
      since_send_time: addDays(settings.campaign.date, -1).toISOString(),
      before_send_time: addDays(settings.campaign.date, 1).toISOString()
    }
  })
  const matchingCampaigns = campaigns.filter(c => c.settings.title === settings.campaign.title)
  if (matchingCampaigns.length !== 1) throw new Error(`Found ${matchingCampaigns.length} matching campaigns. Response was ${campaigns}`)
  return {
    campaignId: matchingCampaigns[0].id,
    listId: matchingCampaigns[0].recipients.list_id
  }
}

const getLinkIds = async campaignId => {
  let {
    data: { urls_clicked: urlsClicked }
  } = await api.get(`/reports/${campaignId}/click-details`, {
    params: { fields: ['urls_clicked.id', 'urls_clicked.url'].join(',') }
  })
  urlsClicked = urlsClicked.filter(({ url }) =>
    url.includes(settings.confirmationUrl)
  )
  return urlsClicked.map(url => url.id)
}

const getTagId = async (listId) => {
  const { data: { segments } } = await api.get(`/lists/${listId}/segments`, {
    params: {
      fields: ['segments.id', 'segments.name'].join(','),
      type: 'static'
    }
  })
  const tags = segments.filter(seg => seg.name === settings.tag)
  if (!tags.length) throw new Error('Found no matching tag')
  return tags[0].id
}

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

(async () => {
  console.log(`Sending request for ${JSON.stringify(settings, null, 2)}`)

  const { campaignId, listId } = await getCampaignInfo()
  console.log(`Received campaignId ${campaignId} and listId ${listId}`)

  const linkIds = await getLinkIds(campaignId)
  console.log(`Received linkIds ${linkIds.join(' ')}`)

  const tagId = await getTagId(listId, campaignId, linkIds)
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
  console.log(`Archiving members by batch operation with ID ${batchId}`)
})()

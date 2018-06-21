const utils = require('../utils')
const solc = require('solc')

const GnosisSafe = artifacts.require("./GnosisSafeTeamEdition.sol")
const ProxyFactory = artifacts.require("./ProxyFactory.sol")


contract('GnosisSafeTeamEdition', function(accounts) {

    let gnosisSafe
    let executor = accounts[8]

    const MAX_GAS_PRICE = web3.toWei(100, 'gwei')

    const CALL = 0
    const CREATE = 2

    let executeTransaction = async function(subject, accounts, to, value, data, operation, sender) {
        let txSender = sender || executor 
        let nonce = utils.currentTimeNs()
        
        let executeData = gnosisSafe.contract.execTransactionIfApproved.getData(to, value, data, operation, nonce)
        assert.equal(await utils.getErrorMessage(gnosisSafe.address, 0, executeData), "Not enough confirmations")

        let approveData = gnosisSafe.contract.approveTransactionWithParameters.getData(to, value, data, operation, nonce)
        assert.equal(await utils.getErrorMessage(gnosisSafe.address, 0, approveData, "0x0000000000000000000000000000000000000002"), "Sender is not an owner")
        for (let account of (accounts.filter(a => a != txSender))) {
            utils.logGasUsage("confirm " + subject + " with " + account, await gnosisSafe.approveTransactionWithParameters(to, value, data, operation, nonce, {from: account}))
        }

        let tx = await gnosisSafe.execTransactionIfApproved(to, value, data, operation, nonce, {from: txSender})
        utils.logGasUsage(subject, tx)

        assert.equal(await utils.getErrorMessage(gnosisSafe.address, 0, approveData, accounts[0]), "Safe transaction already executed")
        assert.equal(await utils.getErrorMessage(gnosisSafe.address, 0, executeData), "Safe transaction already executed")
        return tx
    }

    beforeEach(async function () {
        // Create Master Copies
        let proxyFactory = await ProxyFactory.new()
        let gnosisSafeMasterCopy = await GnosisSafe.new()
        gnosisSafeMasterCopy.setup([accounts[0]], 1, 0, "0x")
        // Create Gnosis Safe
        let gnosisSafeData = await gnosisSafeMasterCopy.contract.setup.getData([accounts[2], accounts[1], accounts[0]], 3, 0, "0x")
        gnosisSafe = utils.getParamFromTxEvent(
            await proxyFactory.createProxy(gnosisSafeMasterCopy.address, gnosisSafeData),
            'ProxyCreation', 'proxy', proxyFactory.address, GnosisSafe, 'create Gnosis Safe',
        )
    })

    it('should remove an owner in a 3 owners with 3 threshold safe', async () => {
        // Add owner and set threshold to 3
        assert.equal(await gnosisSafe.getThreshold(), 3)
        let data = await gnosisSafe.contract.removeOwner.getData('0x0000000000000000000000000000000000000001', accounts[2], 2)
        await executeTransaction('remove owner set threshold to 2', [accounts[0], accounts[1], accounts[2]], gnosisSafe.address, 0, data, CALL)
        assert.deepEqual(await gnosisSafe.getOwners(), [accounts[1], accounts[0]])
        assert.equal(await gnosisSafe.getThreshold(), 2)
    })
})

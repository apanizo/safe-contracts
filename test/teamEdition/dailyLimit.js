const utils = require('../utils')
const solc = require('solc')
const BigNumber = require('bignumber.js');

const CreateAndAddModules = artifacts.require("./libraries/CreateAndAddModules.sol");
const DailyLimitModule = artifacts.require("./modules/DailyLimitModule.sol");
const GnosisSafe = artifacts.require("./GnosisSafeTeamEdition.sol")
const ProxyFactory = artifacts.require("./ProxyFactory.sol")


contract('GnosisSafeTeamEdition', function(accounts) {

    let gnosisSafe
    let executor = accounts[8]

    const MAX_GAS_PRICE = web3.toWei(100, 'gwei')

    const CALL = 0
    const CREATE = 2
    const LIMIT_POSITION = 0
    const SPENT_TODAY_POS = 1

    let executeTransaction = async function(subject, accounts, to, value, data, operation, sender) {
        let txSender = sender || executor 
        let nonce = utils.currentTimeNs()
        
        let executeData = gnosisSafe.contract.execTransactionIfApproved.getData(to, value, data, operation, nonce)
        // assert.equal(await utils.getErrorMessage(gnosisSafe.address, 0, executeData), "Not enough confirmations")

        let approveData = gnosisSafe.contract.approveTransactionWithParameters.getData(to, value, data, operation, nonce)
        assert.equal(await utils.getErrorMessage(gnosisSafe.address, 0, approveData, "0x0000000000000000000000000000000000000002"), "Sender is not an owner")
        for (let account of (accounts.filter(a => a != txSender))) {
            console.log("Confirming tx by user " + account)
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
        let createAndAddModules = await CreateAndAddModules.new()
        let gnosisSafeMasterCopy = await GnosisSafe.new()
        // Initialize safe master copy
        gnosisSafeMasterCopy.setup([accounts[0]], 1, 0, "0x")
        let dailyLimitModuleMasterCopy = await DailyLimitModule.new()
        // Initialize module master copy
        dailyLimitModuleMasterCopy.setup([], [])
        // Create Gnosis Safe and Daily Limit Module in one transactions
        let moduleData = await dailyLimitModuleMasterCopy.contract.setup.getData([0], [100])
        let proxyFactoryData = await proxyFactory.contract.createProxy.getData(dailyLimitModuleMasterCopy.address, moduleData)
        let modulesCreationData = utils.createAndAddModulesData([proxyFactoryData])
        let createAndAddModulesData = createAndAddModules.contract.createAndAddModules.getData(proxyFactory.address, modulesCreationData)
        let gnosisSafeData = await gnosisSafeMasterCopy.contract.setup.getData([accounts[0]], 1, createAndAddModules.address, createAndAddModulesData)
        gnosisSafe = utils.getParamFromTxEvent(
          await proxyFactory.createProxy(gnosisSafeMasterCopy.address, gnosisSafeData),
          'ProxyCreation', 'proxy', proxyFactory.address, GnosisSafe, 'create Gnosis Safe and Daily Limit Module',
        )
        const modules = await gnosisSafe.getModules()
        dailyLimitModule = DailyLimitModule.at(modules[0])
        assert.equal(await dailyLimitModule.manager.call(), gnosisSafe.address)
    })

    const checkDailyLimit = async (token, limit, spentToday) => {
      const dailyLimitEth = await dailyLimitModule.dailyLimits(token)
      assert.equal(limit, new BigNumber(dailyLimitEth[LIMIT_POSITION]).toNumber())
      assert.equal(spentToday, dailyLimitEth[SPENT_TODAY_POS])
    }

    it('should change threshold from 100 to 200', async () => {
        // await web3.eth.sendTransaction({from: accounts[0], to: gnosisSafe.address, value: web3.toWei(0.1, 'ether')})
        // Check the dailyLimit has been initialized correctly
        const ethAddress = 0
        await checkDailyLimit(ethAddress, 100, 0)

        // Prepare data for editing threshold
        const newDailyLimit = 200
        const data = await dailyLimitModule.contract.changeDailyLimit.getData(ethAddress, newDailyLimit)
        await executeTransaction('Edit threshold to 200', [accounts[0]], dailyLimitModule.address, 0, data, CALL, accounts[0])
        await checkDailyLimit(ethAddress, newDailyLimit, 0)
    })
})
